# Render background worker. Build context: backend/ (so contracts/ and config/ are copied next to the package).
#   docker build -f python_engine/Dockerfile -t gini-engine .
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_ENV=production
WORKDIR /app
COPY python_engine/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY python_engine/gini_engine /app/gini_engine
COPY contracts /app/contracts
COPY config /app/config
RUN useradd --create-home --uid 10001 engine && chown -R engine /app
USER engine
CMD ["python", "-m", "gini_engine"]
