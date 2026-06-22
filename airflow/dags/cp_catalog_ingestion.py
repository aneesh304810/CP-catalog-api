"""
CP Metadata Catalog — ingestion DAG.

Runs the harvest after the main pipeline's dbt build. Each connector is a task
so failures are isolated and retryable. Scheduled daily on weekdays; can also be
triggered by the upstream build DAG via TriggerDagRunOperator or a Dataset.

All connection details come from environment variables injected by the
OpenShift Deployment (Secret + ConfigMap) — see deploy/.
"""
from __future__ import annotations
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator

default_args = {
    "owner": "cp-engineering",
    "retries": 2,
    "retry_delay": timedelta(minutes=3),
}


def _step(step_name):
    def _run(**_):
        from ingestion.run import run
        run({step_name})
    return _run


with DAG(
    dag_id="cp_catalog_ingestion",
    description="Harvest metadata from Oracle, SQL Server, dbt and Airflow into METACAT",
    schedule="30 6 * * 1-5",      # after the 06:00 medallion build
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args=default_args,
    tags=["catalog", "metadata", "lineage"],
) as dag:

    harvest_oracle = PythonOperator(
        task_id="harvest_oracle", python_callable=_step("oracle"))
    harvest_mssql = PythonOperator(
        task_id="harvest_mssql", python_callable=_step("mssql"))
    parse_dbt = PythonOperator(
        task_id="parse_dbt_and_column_lineage", python_callable=_step("dbt"))
    harvest_airflow = PythonOperator(
        task_id="harvest_airflow_metadata", python_callable=_step("airflow"))
    apply_overlay = PythonOperator(
        task_id="apply_business_overlay", python_callable=_step("overlay"))
    harvest_quality = PythonOperator(
        task_id="harvest_quality_and_gates", python_callable=_step("quality"))

    # datasets/columns first, then dbt (needs datasets), then airflow
    # (needs dbt model names), quality (needs dbt run_results), overlay last.
    [harvest_oracle, harvest_mssql] >> parse_dbt >> harvest_airflow
    parse_dbt >> harvest_quality
    [harvest_airflow, harvest_quality] >> apply_overlay
