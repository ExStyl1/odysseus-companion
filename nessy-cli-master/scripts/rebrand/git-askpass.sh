#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' oauth2 ;;
  *Password*) printf '%s\n' "$REBRAND_GIT_PASSWORD" ;;
  *) exit 1 ;;
esac
