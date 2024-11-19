# Tracing function
# NOTE: adds significant overhead to startup time, but times traced will 
# still be proportional to a startup without tracing enabled
omzp:on() {
    setopt localoptions localtraps

    # initialization
    zmodload zsh/datetime
    typeset -Ag __OMZP
    __OMZP=(
        PS4     "$PS4" 
        start   "$EPOCHREALTIME"
        outfile "${1:-$HOME}/${${SHELL:t}#-}.$EPOCHSECONDS.$$.zsh-trace.log"
    )
    typeset -g PS4="+0mZ|%e|%D{%s.%9.}|%N|%x|%I> "

    # unload profiler on startup end
    emulate zsh +x -c '
    omzp:off() {
        setopt localoptions localtraps
        trap "{ setopt noxtrace evallineno } 2>/dev/null; exec 2>&3 3>&-" EXIT

        # restore PS4
        typeset -g PS4="$__OMZP[PS4]"
        unset "__OMZP[PS4]"

        # remove precmd function
        add-zsh-hook -d precmd omzp:off
        unfunction omzp:off

        local startup=$(( (EPOCHREALTIME - __OMZP[start]) * 1e3 ))
        printf "%.3f ms – %s \n" "$startup" "${__OMZP[outfile]:t}"
    }'

    autoload -Uz add-zsh-hook
    add-zsh-hook precmd omzp:off

    # redirect debug output to profiler log file
    exec 3>&2 2>${__OMZP[outfile]}

    # enable zsh debug mode
    trap 'setopt xtrace noevallineno' EXIT
}

# Directory to store traces - needs to be created
omzp:on "$HOME/.zsh-trace"
