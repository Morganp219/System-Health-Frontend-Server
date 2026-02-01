# Use lightweight Node image
FROM node:20-alpine

# App directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy app
COPY . .

# Expose backend port
EXPOSE 3001

# Start server automatically
CMD ["node", "server.js"]
