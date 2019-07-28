FROM node:10
WORKDIR /app
COPY package*.json .
RUN npm install
COPY . .
CMD ["node", "index.js"]
ENV LISTENING_URL="ftp://0.0.0.0:21"
EXPOSE 21