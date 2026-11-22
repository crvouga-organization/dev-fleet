# Read-only health probe that `dev-fleet net check` pipes to each host over SSH (`sh -s`).
# Prints key=value lines; works on macOS and Linux (including WSL).
if [ "$(uname)" = Darwin ]; then
  echo "ncpu=$(sysctl -n hw.ncpu)"
  echo "load=$(sysctl -n vm.loadavg | awk '{print $2}')"
  echo "memfree=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/percentage/{gsub("%","",$2); print $2}')"
  sysctl -n vm.swapusage | awk '{t=$3; u=$6; gsub("M","",t); gsub("M","",u); if (t>0) print "swap=" int(u*100/t); else print "swap=0"}'
else
  echo "ncpu=$(nproc)"
  echo "load=$(cut -d' ' -f1 /proc/loadavg)"
  # Free inodes as a percentage: bytes can be free while every write fails.
  df -Pi "$HOME" | awk 'NR==2 && $2>0{print "inodefree=" int($4*100/$2)}'
  # Clock synchronisation, as systemd sees it: 1 or 0.
  timedatectl show -p NTPSynchronized -p NTP 2>/dev/null | awk -F= '{v=($2=="yes")?1:0} $1=="NTP"{print "ntp=" v} $1=="NTPSynchronized"{print "ntpsync=" v}'
  # Agent sessions running now: the scopes T3 starts its agents in.
  uid=$(id -u)
  agents="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/app-t3code.slice/app-t3code-agents.slice"
  if [ -d "$agents" ]; then
    scopes=$(find "$agents" -type d -name 't3code-*.scope' -printf '1\n' 2>/dev/null) &&
      echo "agentsessions=$(echo "$scopes" | awk '/1/{n++} END{print n+0}')"
  elif [ -d "/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service" ]; then
    echo 'agentsessions=0'
  fi
  if [ -d "$agents" ]; then
    # The scopes a declared limit counts (those in the slices T3 owns), and
    # the lowest limit the kernel holds on one of those slices.
    echo "agentscopes=$(find "$agents" -mindepth 2 -maxdepth 2 -type d -path '*/app-t3code-agents-*.slice/t3code-*.scope' -printf '1\n' 2>/dev/null | awk '/1/{n++} END{print n+0}')"
    cat "$agents"/app-t3code-agents-*.slice/cgroup.max.descendants 2>/dev/null | awk '/^[0-9]+$/{if (!n++ || $1<m) m=$1} END{if (n) print "agentlimitheld=" m}'
    # What the running agents took at their peak, to hold against the estimate.
    find "$agents" -type d -name 't3code-*.scope' ! -name 't3code-terminal-*' -exec cat {}/memory.peak \; 2>/dev/null | sort -n |
      awk '/^[0-9]+$/{v[++n]=$1} END{if (n) {print "agentpeaks=" n; print "agentpeakmedianmb=" int(v[int((n+1)/2)]/1048576); print "agentpeakmaxmb=" int(v[n]/1048576)}}'
  fi
  # The limit the worker's own unit holds: the number in the unit while it runs, 0 otherwise.
  limitunit=/etc/systemd/user/personal-fleet-agent-session-limit.service
  if XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}" systemctl --user is-active --quiet "${limitunit##*/}" 2>/dev/null; then
    sed -n 's/^ExecStart=.* --limit \([0-9][0-9]*\) .*/agentlimitunit=\1/p' "$limitunit" 2>/dev/null
  else
    echo 'agentlimitunit=0'
  fi
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} /SwapTotal/{st=$2} /SwapFree/{sf=$2} END{print "memfree=" int(a*100/t); print "memtotalmb=" int(t/1024); if (st>0) print "swap=" int((st-sf)*100/st); else print "swap=0"}' /proc/meminfo
fi
echo "diskmb=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1024)}')"
echo "disktotalmb=$(df -Pk "$HOME" | awk 'NR==2{print int($2/1024)}')"
echo "epoch=$(date +%s)"
