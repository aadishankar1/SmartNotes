#!/bin/bash
#
# Builds SmartNotes for iPad and runs its test suite.
#
# `swift build` is preferred and tried first. It needs a writable Clang module
# cache under the Darwin user cache directory, which some sandboxes deny; the
# manifest compile then fails before any of this package is even read. So when
# SwiftPM cannot run, the same sources are compiled directly with swiftc and an
# explicit --module-cache-path, which is why the test suite is an executable
# target rather than an XCTest bundle.
#
#   ipad/Scripts/build-and-test.sh          build for the host, run the tests
#   ipad/Scripts/build-and-test.sh --ios    also compile every target for iOS
#   ipad/Scripts/build-and-test.sh --app    also link SmartNotes.app for the
#                                           iPad simulator
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
BUILD="${SMARTNOTES_BUILD_DIR:-${TMPDIR:-/tmp}/smartnotes-ipad-build}"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
TOOLCHAIN="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin"
MACOS_SDK="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
IOS_SDK="$DEVELOPER_DIR/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk"
SIM_SDK="$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk"
MACOS_TARGET="arm64-apple-macosx14.0"
IOS_TARGET="arm64-apple-ios17.0"
SIM_TARGET="arm64-apple-ios17.0-simulator"

WANT_IOS=0
WANT_APP=0
for argument in "$@"; do
    case "$argument" in
        --ios) WANT_IOS=1 ;;
        --app) WANT_APP=1 ;;
        *) echo "unknown option $argument" >&2; exit 2 ;;
    esac
done

mkdir -p "$BUILD/mc" || exit 1

say() { printf '\n== %s\n' "$1"; }

# $1 module name, $2 sdk, $3 target, $4 output dir, $5.. sources
build_module() {
    local name="$1" sdk="$2" target="$3" out="$4"
    shift 4
    mkdir -p "$out"
    "$TOOLCHAIN/swiftc" \
        -sdk "$sdk" -target "$target" \
        -module-cache-path "$BUILD/mc" \
        -module-name "$name" \
        -emit-module -emit-module-path "$out/$name.swiftmodule" \
        -emit-library -o "$out/lib$name.dylib" \
        -Xlinker -install_name -Xlinker "@rpath/lib$name.dylib" \
        -I "$out" -L "$out" \
        -swift-version 5 \
        "$@"
}

say "SwiftPM"
if "$TOOLCHAIN/swift" build --package-path "$ROOT" --scratch-path "$BUILD/spm" 2>"$BUILD/spm.log"; then
    echo "swift build succeeded"
    SPM_OK=1
else
    SPM_OK=0
    echo "swift build unavailable; falling back to direct swiftc. Last error:"
    tail -3 "$BUILD/spm.log" | sed 's/^/  /'
fi

HOST="$BUILD/host"
say "SmartNotesKit ($MACOS_TARGET)"
build_module SmartNotesKit "$MACOS_SDK" "$MACOS_TARGET" "$HOST" "$ROOT"/Sources/SmartNotesKit/*.swift || exit 1

say "SmartNotesDocuments ($MACOS_TARGET)"
build_module SmartNotesDocuments "$MACOS_SDK" "$MACOS_TARGET" "$HOST" \
    -lSmartNotesKit "$ROOT"/Sources/SmartNotesDocuments/*.swift || exit 1

say "SmartNotesTests ($MACOS_TARGET)"
"$TOOLCHAIN/swiftc" \
    -sdk "$MACOS_SDK" -target "$MACOS_TARGET" \
    -module-cache-path "$BUILD/mc" \
    -I "$HOST" -L "$HOST" -lSmartNotesKit -lSmartNotesDocuments \
    -Xlinker -rpath -Xlinker "@executable_path" \
    -swift-version 5 \
    -o "$HOST/SmartNotesTests" \
    "$ROOT"/Sources/SmartNotesTests/*.swift || exit 1

if [ "$WANT_IOS" = "1" ]; then
    IOS="$BUILD/ios"
    say "SmartNotesKit ($IOS_TARGET)"
    build_module SmartNotesKit "$IOS_SDK" "$IOS_TARGET" "$IOS" "$ROOT"/Sources/SmartNotesKit/*.swift || exit 1
    say "SmartNotesDocuments ($IOS_TARGET)"
    build_module SmartNotesDocuments "$IOS_SDK" "$IOS_TARGET" "$IOS" \
        -lSmartNotesKit "$ROOT"/Sources/SmartNotesDocuments/*.swift || exit 1
    say "SmartNotesUI ($IOS_TARGET)"
    build_module SmartNotesUI "$IOS_SDK" "$IOS_TARGET" "$IOS" \
        -lSmartNotesKit -lSmartNotesDocuments "$ROOT"/Sources/SmartNotesUI/*.swift || exit 1
    echo "iOS targets compiled"
fi

if [ "$WANT_APP" = "1" ]; then
    # The app bundle proper: the SwiftUI target is compiled into the executable
    # rather than into a library, because `@main` has to be in the binary the
    # bundle launches. It is built for the simulator SDK so it links without a
    # signing identity; the device SDK differs only in --target.
    SIM="$BUILD/sim"
    APP="$BUILD/SmartNotes.app"
    say "SmartNotesKit ($SIM_TARGET)"
    build_module SmartNotesKit "$SIM_SDK" "$SIM_TARGET" "$SIM" "$ROOT"/Sources/SmartNotesKit/*.swift || exit 1
    say "SmartNotesDocuments ($SIM_TARGET)"
    build_module SmartNotesDocuments "$SIM_SDK" "$SIM_TARGET" "$SIM" \
        -lSmartNotesKit "$ROOT"/Sources/SmartNotesDocuments/*.swift || exit 1

    say "SmartNotes.app ($SIM_TARGET)"
    rm -rf "$APP"
    mkdir -p "$APP/Frameworks" || exit 1
    "$TOOLCHAIN/swiftc" \
        -sdk "$SIM_SDK" -target "$SIM_TARGET" \
        -module-cache-path "$BUILD/mc" \
        -module-name SmartNotes \
        -I "$SIM" -L "$SIM" -lSmartNotesKit -lSmartNotesDocuments \
        -Xlinker -rpath -Xlinker "@executable_path/Frameworks" \
        -parse-as-library \
        -swift-version 5 \
        -o "$APP/SmartNotes" \
        "$ROOT"/Sources/SmartNotesUI/*.swift || exit 1
    cp "$SIM"/libSmartNotesKit.dylib "$SIM"/libSmartNotesDocuments.dylib "$APP/Frameworks/" || exit 1
    cp "$ROOT/App/Info.plist" "$APP/Info.plist" || exit 1
    echo "built $APP"
fi

say "Tests"
SMARTNOTES_ROOT="$REPO" "$HOST/SmartNotesTests"
