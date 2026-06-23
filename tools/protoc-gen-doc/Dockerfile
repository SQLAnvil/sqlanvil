# Builds protoc-gen-doc with the `camel_case_fields` option from the
# Ekrekr/protoc-gen-doc fork (PR #540, branch `add-camel-case-option`), which
# upstream pseudomuto/protoc-gen-doc never merged. sqlanvil's sqlx config keys
# are camelCase, so the proto reference (reference/configs.md) must be generated
# with camelCase field names — the stock image only emits snake_case.
#
# Build context must be a checkout of that fork/branch. Use build-image.sh,
# which clones the pinned commit and runs `docker build` with this file.
FROM golang:1.20-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /protoc-gen-doc ./cmd/protoc-gen-doc

FROM alpine:3.15.0
WORKDIR /
RUN apk --update add bash protoc protobuf-dev && rm -rf /var/cache/apk/*
COPY script/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=build /protoc-gen-doc /usr/bin/
VOLUME ["/out"]
VOLUME ["/protos"]
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--doc_opt=html,index.html"]
