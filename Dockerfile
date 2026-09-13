# The viewer, with recording started from the browser. The front-end bundle is committed and the
# backend has no runtime dependencies, so the image needs no npm install and no build step.
FROM node:24.15.0-slim

WORKDIR /app
COPY bin ./bin
COPY src ./src
COPY ui/dist ./ui/dist
COPY package.json ./

ENV NODE_ENV=production
# A public demo should not be able to fill its disk: at defaults one hour is 1.7 GiB.
ENV SIGACQ_MAX_RECORDING_SECONDS=300
ENV SIGACQ_KEEP_RECORDINGS=5

USER node
EXPOSE 8787
CMD ["node", "bin/uiserver.ts", "--recordings", "/tmp/recordings"]
