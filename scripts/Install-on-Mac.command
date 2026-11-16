#!/bin/bash
# Install the adjacent Apple Silicon app and repair its own local signatures.
# This is local ad-hoc signing, NOT Developer ID signing or notarization.
# Apple recommends signing nested code inside out, not using --deep to sign:
# https://developer.apple.com/library/archive/technotes/tn2206/
set -euo pipefail

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf '%s\n' '请在 Apple Silicon Mac 上运行此安装脚本。'
  exit 1
fi
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || printf 0)" != "1" ]; then
  printf '%s\n' '此安装包仅适用于 Apple Silicon（M 系列芯片）。'
  exit 1
fi
system_version=$(/usr/bin/sw_vers -productVersion)
major_version=${system_version%%.*}
minor_version=${system_version#*.}; minor_version=${minor_version%%.*}
if [ "$major_version" -lt 14 ] || { [ "$major_version" -eq 14 ] && [ "$minor_version" -lt 2 ]; }; then
  printf '%s\n' '此版本需要 macOS 14.2 或更新版本。'
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd -P)
app_name='VC Meeting Assistant.app'
source_app="$script_dir/$app_name"
if [ ! -d "$source_app/Contents" ]; then
  printf '%s\n' "请先解压应用，并将此脚本与 $app_name 放在同一文件夹后重试。"
  exit 1
fi
for required in /usr/bin/codesign /usr/bin/ditto /usr/libexec/PlistBuddy /usr/bin/file; do
  if [ ! -x "$required" ]; then printf '缺少系统工具：%s\n' "$required"; exit 1; fi
done
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")
if [ "$bundle_id" != 'com.vcmeeting.assistant' ]; then
  printf '%s\n' '应用标识不匹配，已停止安装。'
  exit 1
fi

destination_dir="$HOME/Applications"
destination="$destination_dir/$app_name"
/bin/mkdir -p "$destination_dir"
if [ -L "$destination" ]; then printf '%s\n' '目标位置是符号链接，已停止安装。'; exit 1; fi
if [ -e "$destination" ]; then
  printf '%s\n' '已存在同名应用。请先退出应用；继续后会备份旧应用，会议数据和配置不会改动。'
  read -r -p '输入 INSTALL 继续安装并备份旧版，或回车取消：' answer
  if [ "$answer" != 'INSTALL' ]; then printf '%s\n' '已取消。'; exit 0; fi
fi

stage=$(/usr/bin/mktemp -d "$destination_dir/.vc-meeting-install.XXXXXX")
cleanup() {
  case "$stage" in "$destination_dir"/.vc-meeting-install.*) /bin/rm -rf "$stage" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM
staged_app="$stage/$app_name"
printf '%s\n' '正在复制应用并为当前 Mac 创建本地签名…'
/usr/bin/ditto "$source_app" "$staged_app"

# Preserve existing executable entitlements before replacing inner signatures.
# Frameworks and shared libraries receive NO entitlements; host executables own
# JIT/audio permissions. Local ad-hoc native modules need library validation off.
bundle_paths=()
entitlement_paths=()
index=0
while IFS= read -r -d '' bundle; do
  bundle_paths+=("$bundle")
  case "$bundle" in
    *.framework) entitlement_paths+=('') ;;
    *)
      entitlements="$stage/entitlements-$index.plist"
      /usr/bin/codesign -d --entitlements :- "$bundle" > "$entitlements" 2>/dev/null || true
      if ! /usr/libexec/PlistBuddy -c Print "$entitlements" >/dev/null 2>&1; then
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>' > "$entitlements"
      fi
      for entitlement in com.apple.security.cs.allow-jit com.apple.security.cs.disable-library-validation com.apple.security.device.audio-input; do
        /usr/libexec/PlistBuddy -c "Set :$entitlement true" "$entitlements" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$entitlement bool true" "$entitlements"
      done
      entitlement_paths+=("$entitlements")
      ;;
  esac
  index=$((index + 1))
done < <(/usr/bin/find "$staged_app" -depth -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0)

# Sign all Mach-O leaves first, including unpacked native speech/ONNX modules.
while IFS= read -r -d '' binary; do
  if /usr/bin/file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    /bin/chmod u+x "$binary"
    /usr/bin/codesign --force --sign - --timestamp=none "$binary"
  fi
done < <(/usr/bin/find "$staged_app" -type f -print0)

# find -depth placed nested helper bundles/frameworks before the outer app.
for ((index=0; index<${#bundle_paths[@]}; index++)); do
  bundle=${bundle_paths[$index]}
  entitlements=${entitlement_paths[$index]}
  if [ -n "$entitlements" ]; then
    /usr/bin/codesign --force --sign - --timestamp=none --options runtime --generate-entitlement-der --entitlements "$entitlements" "$bundle"
  else
    /usr/bin/codesign --force --sign - --timestamp=none "$bundle"
  fi
done
/usr/bin/codesign --verify --deep --strict --verbose=2 "$staged_app"

backup=''
if [ -e "$destination" ]; then
  backup="$destination_dir/VC Meeting Assistant.backup.$(/bin/date +%Y%m%d-%H%M%S).$$.app"
  /bin/mv "$destination" "$backup"
fi
if ! /bin/mv "$staged_app" "$destination"; then
  if [ -n "$backup" ] && [ ! -e "$destination" ]; then /bin/mv "$backup" "$destination"; fi
  printf '%s\n' '安装失败，已尝试恢复旧版。'; exit 1
fi
printf '\n已安装：%s\n' "$destination"
if [ -n "$backup" ]; then printf '旧版备份：%s\n' "$backup"; fi
printf '%s\n' \
  '这是本机临时签名，未取得 Apple Developer ID 签名或公证。' \
  '脚本没有修改 Gatekeeper、移除隔离属性或更改系统安全设置。' \
  '首次打开时，macOS 仍可能阻止未公证应用；请按系统提示在“隐私与安全性”中审核是否允许。' \
  '麦克风和系统音频授权会在你点击“开始录音”时请求；会议数据与 .env 配置保留在用户应用数据目录。' \
  '此安装流程尚未在 Mac 真机执行验证。如系统仍拒绝启动，请保留错误提示，不要关闭系统安全保护。'
read -r -p '按回车结束。' _
