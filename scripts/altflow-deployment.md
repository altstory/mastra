# Agent 镜像保留和构建缓存

## 上传入口和构建规格

Agent 的 Nginx HTTPS `server` 块必须设置 `client_max_body_size 20m;`，与 Go 和 Agent 的文件上传上限一致。Dev ECS 的配置文件是 `/etc/nginx/conf.d/harness-dev.conf`。修改后先执行 `nginx -t`，再执行 `systemctl reload nginx`；等待新 worker 接管后验证。不配置时 Nginx 默认的 1 MiB 上限会在文件到达 Agent 前返回 413。

云效 `harness-dev` 使用 `instanceType: SMALL_1C2G`。在线流水线和仓库 YAML 保持一致，避免同步配置时恢复成更大的计费规格。

## 镜像保留

`deploy-altflow-agent.sh` 在新容器通过健康检查后，清理同一个 Agent 镜像仓库中未被容器引用的旧版本。保留当前镜像和上一个已验证的镜像，以不可变镜像 ID 记录在 `/var/lib/altflow/.agent-healthy-images`。重复部署当前版本不会轮换回滚版本；发布失败不触发清理。其他仓库、数据卷、运行库和构建缓存不参与清理。

部署期间需要容纳新镜像下载的临时空间。镜像仍被其他容器引用时会额外保留，因此本规则限制发布历史的累积，不是磁盘硬配额。ACR 远端历史版本的保留策略与 ECS 本机清理独立。

运行 `bash scripts/test-deploy-image-retention.sh` 使用真实本机 Docker 验证当前版本、回滚版本、停止容器引用和其他仓库均被保留，且未使用的旧标签被删除。测试只创建和清理自己的临时资源。

## 构建缓存

云效 `harness-dev`（5423072）的镜像构建步骤保留原有远程缓存，并在 `options` 增加以下固定缓存引用：

```text
--cache-from type=registry,ref=altstory-registry.cn-beijing.cr.aliyuncs.com/altflow/altflow-agent:flow-intermediate-cache
--cache-to type=registry,ref=altstory-registry.cn-beijing.cr.aliyuncs.com/altflow/altflow-agent:flow-intermediate-cache,mode=max,image-manifest=true,oci-mediatypes=true
```

`mode=max` 导出多阶段构建的中间结果，包含依赖安装层。固定标签重复更新，不按发布次数创建新缓存标签。首次运行需要填充缓存；后续依赖清单和安装命令不变时可复用安装层。锁文件或安装输入变化仍需重装，`RUN --mount=type=cache` 的 pnpm store 不会随普通 registry 缓存导出到新的 BuildKit 实例。不能承诺每次都零下载。

参考：[Docker registry cache](https://docs.docker.com/build/cache/backends/registry/)。
