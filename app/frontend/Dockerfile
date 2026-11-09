# V (green-path): non-root nginx. The unprivileged image runs as uid 101 and
# listens on 8080, so no root is needed (satisfies Semgrep missing-user + Trivy).
FROM nginxinc/nginx-unprivileged:1.27-alpine

USER root
# Replace the default config with our reverse-proxy config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/shieldops.conf
COPY index.html /usr/share/nginx/html/index.html

# Drop back to the built-in non-root user.
USER 101

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
