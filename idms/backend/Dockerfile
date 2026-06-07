# Production-ready Dockerfile for FastAPI on Azure Web App
FROM python:3.10-slim

# Prevent Python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Install system dependencies (needed for compiling psycopg2 and health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Copy dependency files first for optimal caching
COPY requirements.txt .

# Install dependencies globally
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Create a non-root user and group for security
RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /bin/false -d /app appuser

# Ensure the non-root user owns the working directory so it can write temporary/schedule files
RUN chown -R appuser:appgroup /app

# Switch to the non-root user
USER appuser

# Expose default port
EXPOSE 8000

# Run FastAPI using uvicorn under shell to dynamically resolve PORT env var
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]