# --- build stage ---
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS build
WORKDIR /app
COPY ui/package.json ui/package-lock.json* ./
ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && \
    npm install
COPY ui/ ./
# API base is same-origin /api by default (nginx proxies to the API service)
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# --- runtime stage (nginx, non-root) ---
FROM registry.access.redhat.com/ubi9/nginx-124:latest
COPY --from=build /app/dist /opt/app-root/src
COPY deploy/nginx.conf /etc/nginx/nginx.conf
# OpenShift runs as arbitrary UID in root group
USER 0
RUN chgrp -R 0 /opt/app-root/src /var/log/nginx /var/lib/nginx && \
    chmod -R g=u /opt/app-root/src /var/log/nginx /var/lib/nginx
USER 1001
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
