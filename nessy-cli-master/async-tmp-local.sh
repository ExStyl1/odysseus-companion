#!/bin/zsh
DP_TOKEN=`dp auth print-token`
docker build -f async.Dockerfile -t nessy-async . && docker run --rm -e DP_TOKEN="$DP_TOKEN" nessy-async
