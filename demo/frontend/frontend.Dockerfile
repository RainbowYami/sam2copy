FROM node:22.9.0

WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json ./
COPY yarn.lock ./

# Install dependencies including devDependencies
RUN yarn install

# The source code will be mounted as a volume in docker-compose.yaml
# This allows for hot-reloading and debugging TypeScript directly

EXPOSE 5173

# Start Vite dev server with host and port explicitly set
CMD ["yarn", "vite", "--host", "0.0.0.0", "--port", "5173"]
