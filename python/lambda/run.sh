#!/bin/bash
exec python -m uvicorn chatticus.http.lambda_app:app --host 0.0.0.0 --port 8080
