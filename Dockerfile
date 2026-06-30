FROM denoland/deno:2.9.0

WORKDIR /app

COPY deno.json deno.lock ./
COPY src ./src

RUN deno cache src/main.ts \
  && mkdir -p /app/data \
  && chown -R deno:deno /app

ENV DEBOT_DATA_DIR=/app/data
ENV DEBOT_HOST=0.0.0.0
ENV DEBOT_PORT=18080

EXPOSE 18080
USER deno

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "src/main.ts"]
