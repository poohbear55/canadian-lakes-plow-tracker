# Build: docker build -t plow-tracker .
# Run:   docker run -p 3000:3000 -e TRUCK1_PIN=... -e TRUCK2_PIN=... -e TRUCK3_PIN=... -e ADMIN_PIN=... -v plow-data:/app/data plow-tracker
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
