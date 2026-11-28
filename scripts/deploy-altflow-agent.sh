#!/usr/bin/env bash
set -Eeuo pipefail

record_healthy_image() {
  local state_file="$1" image_id="$2" current='' previous='' temporary
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  if [[ -f "$state_file" ]]; then
    read -r current previous < "$state_file" || return 1
    [[ "$current" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
    [[ -z "$previous" || "$previous" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  fi
  if [[ "$image_id" != "$current" ]]; then
    previous="$current"
  fi
  temporary="$(mktemp "${state_file}.XXXXXX")" || return 1
  printf '%s %s\n' "$image_id" "$previous" > "$temporary"
  mv "$temporary" "$state_file"
}

cleanup_agent_images() {
  local repository="$1" current="$2" previous="$3"
  local images containers referenced='' container image_repository tag image_id
  [[ "$current" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ -z "$previous" || "$previous" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  images="$(docker image ls --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}')" || return 1
  containers="$(docker container ls -aq)" || return 1
  for container in $containers; do
    image_id="$(docker container inspect --format '{{.Image}}' "$container")" || return 1
    referenced+=" $image_id"
  done
  while read -r image_repository tag image_id; do
    [[ "$image_repository" == "$repository" && "$tag" != '<none>' ]] || continue
    [[ "$image_id" != "$current" && "$image_id" != "$previous" ]] || continue
    [[ " $referenced " != *" $image_id "* ]] || continue
    echo "清理未使用的旧 Agent 镜像：$image_repository:$tag"
    docker image rm "$image_repository:$tag" || return 1
  done <<< "$images"
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

image="${1:?release image is required}"
app_dir="${2:?application directory is required}"
container_name="${3:?container name is required}"
runtime_dir="${4:?runtime directory is required}"

if [[ "$app_dir" != '/apps/altflow' || "$container_name" != 'altflow-agent' || "$runtime_dir" != '/var/lib/altflow' ]]; then
  echo '拒绝使用非预期的 Agent 部署路径或容器名。' >&2
  exit 2
fi
repository='altstory-registry.cn-beijing.cr.aliyuncs.com/altflow/altflow-agent'
if [[ "$image" != "$repository:"* || ! "${image#"$repository:"}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
  echo '镜像引用格式无效。' >&2
  exit 2
fi

env_file="$app_dir/.env"
[[ -s "$env_file" ]] || { echo 'Agent 环境文件缺失或为空。' >&2; exit 2; }
[[ -d "$runtime_dir" ]] || { echo 'Agent 持久化目录不存在。' >&2; exit 2; }

exec 9>"$runtime_dir/.agent-deploy.lock"
flock -n 9 || { echo '已有 Agent 发布正在执行。' >&2; exit 1; }

docker pull "$image" >/dev/null
state_file="$runtime_dir/.agent-healthy-images"
if docker container inspect "$container_name" >/dev/null 2>&1; then
  if [[ "$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_name")" == 'healthy' ]]; then
    record_healthy_image "$state_file" "$(docker container inspect --format '{{.Image}}' "$container_name")"
  fi
  docker stop --time 30 "$container_name" >/dev/null
  docker rm "$container_name" >/dev/null
fi

docker run -d \
  --name "$container_name" \
  --network host \
  --init \
  --user 1000:1000 \
  --env-file "$env_file" \
  --env ALTFLOW_RUNTIME_ROOT="$runtime_dir" \
  --volume "$runtime_dir:$runtime_dir:rw" \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  "$image" >/dev/null

healthy=0
for _ in $(seq 1 450); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_name" 2>/dev/null || true)"
  if [[ "$state" == 'healthy' ]]; then
    healthy=1
    break
  fi
  running="$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)"
  [[ "$running" == 'true' ]] || break
  sleep 2
done

if (( ! healthy )); then
  docker logs --tail 20 "$container_name" >&2 || true
  echo '新 Agent 未通过健康检查，已停止容器。' >&2
  docker stop --time 30 "$container_name" >/dev/null 2>&1 || true
  exit 1
fi

docker update --restart unless-stopped "$container_name" >/dev/null
record_healthy_image "$state_file" "$(docker container inspect --format '{{.Image}}' "$container_name")"
read -r current_image previous_image < "$state_file"
cleanup_agent_images "$repository" "$current_image" "$previous_image" || echo '旧镜像清理未完成，下次发布时重试；当前 Agent 已健康运行。' >&2
echo "Agent 已运行：$image"
