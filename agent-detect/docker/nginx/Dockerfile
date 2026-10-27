# nginx in front of the demo app. Uses nginx/demo.conf unchanged; 40-agent-demo.sh fills it in at start.
FROM nginx:1.30.6-alpine

# openssl makes the self-signed certificate used until a Let's Encrypt one exists.
RUN apk add --no-cache openssl && rm -f /etc/nginx/conf.d/default.conf
COPY nginx/demo.conf /etc/agent-demo/demo.conf
COPY --chmod=755 docker/nginx/40-agent-demo.sh /docker-entrypoint.d/40-agent-demo.sh
