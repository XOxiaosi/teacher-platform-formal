FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-bookworm-slim AS backend
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
EXPOSE 3001
CMD ["node", "packages/backend/dist/index.js"]

FROM nginx:alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/frontend/dist/ /usr/share/nginx/html/
COPY --from=build /app/packages/admin/dist/ /usr/share/nginx/html/admin/
EXPOSE 443
