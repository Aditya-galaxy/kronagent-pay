# Kronagent Pay — container for Google Cloud Run.
#
# Two competition requirements meet here: the base rules require the project to
# run on Google Cloud Platform, and judges must be able to reach a working
# instance "free of charge and without any restriction" until judging ends.
#
# Deliberately minimal. A judge's session must not be able to fail on a build
# step, and the fewer moving parts between them and the demo, the fewer ways
# that happens. There is no bundler, no transpile step and no node_modules in
# the final image: Bun runs the TypeScript directly, and the app's runtime
# dependency list is empty by design.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Manifests first so the dependency layer is cached independently of source.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

COPY src ./src
COPY README.md LICENSE ./

# Cloud Run injects PORT and expects the container to honour it. 8080 is the
# platform default and the fallback in server.ts.
ENV NODE_ENV=production
EXPOSE 8080

# Run unprivileged. The image ships a `bun` user; nothing here needs root.
USER bun

# Exec form so signals reach the process directly — Cloud Run sends SIGTERM on
# scale-down, and a shell wrapper would swallow it and force a 10s kill.
CMD ["bun", "run", "src/server.ts"]
