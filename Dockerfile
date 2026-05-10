FROM node:18-alpine AS backend-deps
WORKDIR /app/backend/
COPY ./backend/package*.json ./
RUN npm install

FROM node:18-alpine AS frontend-build
WORKDIR /app/frontend/
COPY ./frontend/package*.json ./
RUN npm install
COPY ./frontend/ ./
RUN npm run build

FROM node:18-alpine
WORKDIR /app/
COPY --from=backend-deps /app/backend/node_modules/ ./backend/node_modules/
COPY --from=frontend-build /app/frontend/build/ ./frontend/build/
COPY ./backend/ ./backend/
