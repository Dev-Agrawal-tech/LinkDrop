FROM node:24-alpine
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/backend
CMD ["node", "--env-file-if-exists=.env", "server.js"]
