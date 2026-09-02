"""Lambda Web Adapter entry for the Chatticus HTTP front door."""

from chatticus.http.app import create_app
from chatticus.runtime import cognito_verifier_from_env, plane_from_env

app = create_app(
    plane_from_env(),
    cognito_verifier=cognito_verifier_from_env(),
)
