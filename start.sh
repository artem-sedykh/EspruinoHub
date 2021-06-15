#!/bin/bash
cd `dirname $0`

# Stop terminal screensaver
setterm --blank 0

sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)

# start properly
node index.js
