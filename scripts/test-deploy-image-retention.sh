#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/deploy-altflow-agent.sh"

test_dir="$(mktemp -d)"
repository="altflow-retention-check-$$"
other_repository="$repository-other"
container="$repository-held"
cleanup() {
  docker container rm "$container" >/dev/null 2>&1 || true
  for ref in current previous stale stale-alias held; do
    docker image rm "$repository:$ref" >/dev/null 2>&1 || true
  done
  docker image rm "$other_repository:keep" >/dev/null 2>&1 || true
  rm -r "$test_dir"
}
trap cleanup EXIT
for version in current previous stale held; do
  printf '%s\n' "$version" > "$test_dir/version"
  tar -C "$test_dir" -cf - version | docker image import - "$repository:$version" >/dev/null
done
docker image tag "$repository:stale" "$repository:stale-alias"
docker image tag "$repository:stale" "$other_repository:keep"
docker container create --name "$container" "$repository:held" /bin/true >/dev/null
current="$(docker image inspect --format '{{.Id}}' "$repository:current")"
previous="$(docker image inspect --format '{{.Id}}' "$repository:previous")"
state_file="$test_dir/state"
record_healthy_image "$state_file" "$previous"
record_healthy_image "$state_file" "$current"
record_healthy_image "$state_file" "$current"
read -r actual_current actual_previous < "$state_file"
[[ "$actual_current" == "$current" && "$actual_previous" == "$previous" ]]
cleanup_agent_images "$repository" "$current" "$previous"
for ref in "$repository:current" "$repository:previous" "$repository:held" "$other_repository:keep"; do
  docker image inspect "$ref" >/dev/null
done
for ref in "$repository:stale" "$repository:stale-alias"; do
  if docker image inspect "$ref" >/dev/null 2>&1; then
    echo "未清理旧镜像：$ref" >&2
    exit 1
  fi
done
record_healthy_image "$state_file" "$previous"
read -r actual_current actual_previous < "$state_file"
[[ "$actual_current" == "$previous" && "$actual_previous" == "$current" ]]
echo 'PASS: 保留当前/回滚版本、重复发布不轮换、保护容器引用和其他仓库、清理旧版本所有标签。'
