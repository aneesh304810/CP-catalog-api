# CP Catalog API — FastAPI + oracledb (thin mode, no Instant Client needed)
FROM registry.access.redhat.com/ubi9/python-311:latest

USER 0
WORKDIR /app

# system deps for pyodbc (SQL Server) — msodbcsql is optional at runtime
RUN dnf install -y unixODBC unixODBC-devel gcc && dnf clean all

COPY api/requirements.txt /app/requirements.txt
ARG PIP_INDEX_URL=""
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /app/requirements.txt; \
    else \
      pip install --no-cache-dir -r /app/requirements.txt; \
    fi

COPY api/ /app/api/
COPY ingestion/ /app/ingestion/

# OpenShift runs containers with an arbitrary non-root UID in the root group.
RUN chgrp -R 0 /app && chmod -R g=u /app
USER 1001

EXPOSE 8000
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
CMD ["uvicorn", "api.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
