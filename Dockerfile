# syntax=docker/dockerfile:1
# 多阶段构建：node 构建前端 → go 编译（交叉编译，不需要 QEMU）→ distroless 运行镜像。
# 本地构建：docker build -t lode .
# 多架构：docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t lode .

FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /src
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/
RUN pnpm -C web install --frozen-lockfile
COPY web web
# 前端构建输出到 server/internal/webui/dist
RUN mkdir -p server/internal/webui && pnpm -C web build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS server
ARG TARGETOS TARGETARCH TARGETVARIANT
ARG VERSION=dev
ARG COMMIT=unknown
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
COPY --from=web /src/server/internal/webui/dist internal/webui/dist
RUN GOARM="${TARGETVARIANT#v}" CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" -o /out/lode ./cmd/lode \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="Lode" \
      org.opencontainers.image.description="自托管、单用户的 Markdown 笔记 PWA" \
      org.opencontainers.image.source="https://github.com/rt-game-440/lode" \
      org.opencontainers.image.licenses="MIT"
COPY --from=server /out/lode /usr/local/bin/lode
# 数据卷归非 root 用户所有（uid 65532），新建的命名卷会继承这个属主
COPY --from=server --chown=65532:65532 /out/data /data
ENV LODE_ADDR=0.0.0.0:8787 \
    LODE_DATA_DIR=/data \
    LODE_LOG_LEVEL=info \
    GOMEMLIMIT=100MiB
VOLUME /data
EXPOSE 8787
USER nonroot:nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["lode", "healthcheck"]
ENTRYPOINT ["lode"]
CMD ["serve"]
