// MDM stand-in for probing the codex-app-server this app ships (F1.636).
//
// WHAT IT IS. A macOS configuration profile deploys codex requirements as the
// forced managed preference com.openai.codex : requirements_toml_base64. This
// dylib, interposed into ONE scratch copy of codex-app-server, answers that one
// key from an environment variable in that child only, so codex's own MDM reader
// (codex-rs/config/src/loader/macos.rs) sees an administrator requirement. The
// user's real com.openai.codex preferences are never read and never written:
// every other key of that domain answers "absent" and "not forced", so the probe
// is isolated from the user's Codex desktop app. Every other domain passes
// through untouched. Used by the lane probes behind F1.482, F1.514, F1.516 and
// F1.589 (WJ-ag, WJ-an, WJ-az, WJ-bt; the probes and logs stay under the
// untracked work/ folder of the lanes that ran them).
//
// WHY THIS VERSION. Since codex rust-v0.156.1 (the tag this app ships, per
// packages/codex-protocol/manifest.json) the loader reads ONLY forced preferences.
// Its module doc says "Loads administrator configuration only from forced macOS
// preferences": load_managed_preference_with asks CFPreferencesAppValueIsForced
// BEFORE and AFTER CFPreferencesCopyAppValue and returns None when the value is
// not forced. At rust-v0.154.0 the same file never asks (read from
// github.com/openai/codex at both tags, 2026-09-26). WJ-ag's first stand-in
// interposed CopyAppValue alone, so on 0.156.1 it is never consulted and the
// probe SILENTLY reads "no requirement": measured by WJ-bt on 2026-09-24, an
// empty interpose log, configRequirements/read answering null and the turn going
// to our provider. This file answers both calls, forced only for the key it
// supplies. On 0.154.0 IsForced is simply never called and CopyAppValue still
// answers, so this one file serves both versions and replaces the older one.
//
// WHAT THIS MEANS AT A SITTING. A user-writable
//   defaults write com.openai.codex requirements_toml_base64 <base64>
// is NOT forced, so codex >= 0.156.1 ignores it. The MDM arms of a live sitting
// (WJ-ag ask 4, WJ-az ask 1, WJ-bt ask 3) need a real configuration profile
// installed on the Mac; without one, the binary measurement taken with this
// stand-in is the evidence.
//
// HOW TO USE IT, in a scratch folder only (never the staged file, never the
// packaged app, never a process you did not start for the probe):
//   1. clang -dynamiclib -framework CoreFoundation \
//        -o <scratch>/libwjbtmdm.dylib scripts/cdp/fixtures/mdm/interpose-wjbt.c
//   2. Copy apps/electron/resources/bin/codex/darwin-<arch>/codex-app-server
//      into <scratch> and re-sign the COPY ad hoc (codesign --force --sign -),
//      because dyld ignores DYLD_INSERT_LIBRARIES for the hardened-runtime
//      original.
//   3. Spawn the copy with DYLD_INSERT_LIBRARIES=<scratch>/libwjbtmdm.dylib,
//      WJAG_REQUIREMENTS_B64=<base64 of the requirements.toml under test> and,
//      optionally, WJAG_INTERPOSE_LOG=<scratch>/interpose.log (one line per call
//      codex made). Unset WJAG_REQUIREMENTS_B64 is the no-requirement control.
//   Read the result off configRequirements/read and the log, never off a
//   missing error: an empty log means the stand-in was not consulted.
// The WJAG_ names are kept because the lane probes already spell them.
//
// Landed verbatim from work/wjbt/mdm/interpose-wjbt.c (WJ-bt, 2026-09-24); only
// this header is new.
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <stdio.h>

static void wjbt_log(const char *what, CFStringRef key) {
  const char *logPath = getenv("WJAG_INTERPOSE_LOG");
  if (!logPath) return;
  FILE *log = fopen(logPath, "a");
  if (!log) return;
  char k[256] = {0};
  if (key) CFStringGetCString(key, k, sizeof k, kCFStringEncodingUTF8);
  fprintf(log, "%s(%s, com.openai.codex)\n", what, k);
  fclose(log);
}

static int wjbt_is_ours(CFStringRef appID) {
  return appID && CFStringCompare(appID, CFSTR("com.openai.codex"), 0) == kCFCompareEqualTo;
}

static int wjbt_supplied(CFStringRef key) {
  return key && getenv("WJAG_REQUIREMENTS_B64")
    && CFStringCompare(key, CFSTR("requirements_toml_base64"), 0) == kCFCompareEqualTo;
}

static CFPropertyListRef wjbt_CopyAppValue(CFStringRef key, CFStringRef appID) {
  if (wjbt_is_ours(appID)) {
    wjbt_log("CFPreferencesCopyAppValue", key);
    if (wjbt_supplied(key)) {
      return CFStringCreateWithCString(kCFAllocatorDefault, getenv("WJAG_REQUIREMENTS_B64"), kCFStringEncodingUTF8);
    }
    return NULL;
  }
  return CFPreferencesCopyAppValue(key, appID);
}

static Boolean wjbt_IsForced(CFStringRef key, CFStringRef appID) {
  if (wjbt_is_ours(appID)) {
    wjbt_log("CFPreferencesAppValueIsForced", key);
    return wjbt_supplied(key) ? true : false;
  }
  return CFPreferencesAppValueIsForced(key, appID);
}

__attribute__((used)) static struct { const void *replacement; const void *replacee; }
  interposers[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)(unsigned long)&wjbt_CopyAppValue, (const void *)(unsigned long)&CFPreferencesCopyAppValue },
    { (const void *)(unsigned long)&wjbt_IsForced, (const void *)(unsigned long)&CFPreferencesAppValueIsForced },
  };
