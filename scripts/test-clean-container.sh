#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
image_tag="tiangong-ai-cli-clean-test:local-$$"

if [ "$(uname -s)" = "Linux" ] && [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    IFS= read -r apparmor_restrict_unprivileged_userns \
        < /proc/sys/kernel/apparmor_restrict_unprivileged_userns
    if [ "$apparmor_restrict_unprivileged_userns" = "1" ]; then
        echo "Clean-container tests require nested unprivileged user namespaces for Bubblewrap." >&2
        echo "Set kernel.apparmor_restrict_unprivileged_userns=0 for this test host, then retry." >&2
        exit 1
    fi
fi

cleanup() {
    docker image rm --force "$image_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker build \
    --no-cache \
    --file "$repo_root/Dockerfile.clean-test" \
    --tag "$image_tag" \
    "$repo_root"

docker run \
    --rm \
    --init \
    --network none \
    --privileged \
    --tmpfs /tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=1777 \
    --tmpfs /home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700 \
    "$image_tag"
