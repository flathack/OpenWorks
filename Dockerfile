FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && install -d -m 0700 -o 10001 -g 10001 /data
COPY server/ ./server/
USER 10001:10001
CMD ["python", "-m", "server.app", "serve", "--host", "0.0.0.0", "--port", "8787", "--data", "/data", "--secure-cookie"]
