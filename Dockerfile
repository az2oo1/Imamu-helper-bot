# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code and TS config
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript to dist/
RUN npm run build

# Stage 2: Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Install bash & ca-certificates
RUN apk add --no-cache ca-certificates bash

# Copy package descriptors
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled Javascript bundle from builder stage
COPY --from=builder /app/dist ./dist

# Create session directory
RUN mkdir -p /app/auth_info_baileys

# Expose API & Healthcheck port
EXPOSE 3001

ENV PORT=3001
ENV NODE_ENV=production

# Start bot service
CMD ["node", "dist/index.js"]
