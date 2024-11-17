import {Profile, ProfileGroup, CallTreeProfileBuilder, FrameInfo} from '../lib/profile'
import {TextFileContent} from './utils'
import {TimeFormatter} from '../lib/value-formatters'
import {FileFormat} from '../lib/file-format-spec'
import matchAll from 'string.prototype.matchall'

interface ParsedLogLine {
  level: number
  timestamp: number
  name: string
  file: string
  line_number: number
  code: string
}

interface CallStackFrame {
  frameId: number
  level: number
  timestamp: number
  code: string
}

export function importFromZshTrace(
  contents: TextFileContent,
  fileName: string,
): ProfileGroup | null {
  try {
    // Parse and sort log lines (keep existing parsing code)...
    const reorderedLog = parseAndSortLogLines(contents)

    // Convert to Evented Profile format
    const [eventedProfile, frames] = convertToEventedProfile(reorderedLog)

    // Use similar pattern as importSpeedscopeProfile
    const profile = importEventedProfile(eventedProfile, frames)
    profile.setName(fileName)

    return {
      name: fileName,
      indexToView: 0,
      profiles: [profile],
    }
  } catch (e) {
    console.error('Failed to parse zsh trace:', e)
    return null
  }
}

function importEventedProfile(
  evented: FileFormat.EventedProfile,
  frames: FileFormat.Frame[],
): Profile {
  const {startValue, endValue, events} = evented
  const profile = new CallTreeProfileBuilder(endValue - startValue)

  // Set common properties like in importSpeedscopeProfile
  profile.setValueFormatter(new TimeFormatter('seconds'))
  profile.setName(evented.name)

  // Convert frames to FrameInfo array
  const frameInfos: FrameInfo[] = frames.map((frame, i) => ({
    key: i,
    name: frame.name,
    file: frame.file,
    line: frame.line,
    executedCode: frame.executedCode,
  }))

  // Process events in order
  for (let ev of events) {
    switch (ev.type) {
      case FileFormat.EventType.OPEN_FRAME:
        profile.enterFrame(frameInfos[ev.frame], ev.at - startValue)
        break
      case FileFormat.EventType.CLOSE_FRAME:
        profile.leaveFrame(frameInfos[ev.frame], ev.at - startValue)
        break
    }
  }

  return profile.build()
}

function convertToEventedProfile(
  logLines: ParsedLogLine[],
): [FileFormat.EventedProfile, FileFormat.Frame[]] {
  const frames: FileFormat.Frame[] = []
  const events: FileFormat.EventedProfile['events'] = []
  const frameMap: Record<string, number> = {}
  const callStack: CallStackFrame[] = []

  for (const line of logLines) {
    const frameKey = `${line.name}:${line.line_number}`

    // Get or create frame index
    let frameIndex = frameMap[frameKey]
    if (frameIndex === undefined) {
      frameIndex = frames.length
      frameMap[frameKey] = frameIndex
      frames.push({
        name: line.name,
        file: line.file,
        line: line.line_number,
        executedCode: [],
      })
    }

    // Close frames that have ended
    while (callStack.length && callStack[callStack.length - 1].level >= line.level) {
      const lastFrame = callStack.pop()!

      // Add executedCode info
      const duration = line.timestamp - lastFrame.timestamp
      frames[lastFrame.frameId].executedCode?.push({
        code: lastFrame.code,
        duration,
      })

      // Add close event
      events.push({
        type: FileFormat.EventType.CLOSE_FRAME,
        at: line.timestamp,
        frame: lastFrame.frameId,
      })
    }

    // Open new frame
    events.push({
      type: FileFormat.EventType.OPEN_FRAME,
      at: line.timestamp,
      frame: frameIndex,
    })

    callStack.push({
      frameId: frameIndex,
      level: line.level,
      timestamp: line.timestamp,
      code: line.code,
    })
  }

  // Close any remaining frames in the call stack
  if (callStack.length > 0) {
    const finalTimestamp = events[events.length - 1].at

    while (callStack.length > 0) {
      const lastFrame = callStack.pop()!
      const duration = finalTimestamp - lastFrame.timestamp

      // Add executedCode info for remaining frames
      frames[lastFrame.frameId].executedCode?.push({
        code: logLines[logLines.length - 1].code,
        duration,
      })

      // Add final close events
      events.push({
        type: FileFormat.EventType.CLOSE_FRAME,
        at: finalTimestamp,
        frame: lastFrame.frameId,
      })
    }
  }

  // Get time bounds
  const startValue = events.length ? events[0].at : 0
  const endValue = events.length ? events[events.length - 1].at : 0

  return [
    {
      type: FileFormat.ProfileType.EVENTED,
      name: 'Execution Profile',
      unit: 'seconds',
      startValue,
      endValue,
      events,
    },
    frames,
  ]
}

function parseAndSortLogLines(contents: TextFileContent): ParsedLogLine[] {
  const LOG_LINE_PATTERN = /^\+0mZ\|(\d+)\|([\d\.]+)\|([^|]+)\|([^|]+)\|(\d+)>?\s(.*)$/
  const LOG_SEGMENT_PATTERN =
    /\+0mZ\|(\d+)\|([\d\.]+)\|([^|]+)\|([^|]+)\|(\d+)>\s(.+?)(?=$|\+0mZ\|[^%])/g

  const lines = contents.splitLines()
  const reorderedLog: ParsedLogLine[] = []

  // First pass - parse and collect all log entries
  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue

    // Try to match segments first
    const segments = Array.from(matchAll(trimmedLine, LOG_SEGMENT_PATTERN))
    if (segments.length > 0) {
      for (const match of segments) {
        reorderedLog.push({
          level: parseInt(match[1]),
          timestamp: parseFloat(match[2]),
          name: match[3].trim(),
          file: match[4].trim(),
          line_number: parseInt(match[5]),
          code: match[6].trim(),
        })
      }
    } else {
      // Try single line match
      const match = trimmedLine.match(LOG_LINE_PATTERN)
      if (match) {
        reorderedLog.push({
          level: parseInt(match[1]),
          timestamp: parseFloat(match[2]),
          name: match[3].trim(),
          file: match[4].trim(),
          line_number: parseInt(match[5]),
          code: match[6].trim(),
        })
      }
    }
  }

  // Sort by timestamp
  reorderedLog.sort((a, b) => a.timestamp - b.timestamp)

  return reorderedLog
}
