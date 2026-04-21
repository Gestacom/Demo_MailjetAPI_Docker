FROM node:22-alpine

WORKDIR /usr/src/app

COPY package.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh /usr/local/bin/mailjet-entrypoint

RUN chmod +x /usr/local/bin/mailjet-entrypoint \
    && mkdir -p /usr/src/app/storage/accounts /usr/src/app/storage/locks /usr/src/app/logs \
    && chown -R node:node /usr/src/app

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_STORAGE_DIR=/usr/src/app/storage
ENV APP_LOGS_DIR=/usr/src/app/logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["mailjet-entrypoint"]
CMD ["node", "src/server.js"]
