from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorDetail(BaseModel):
    code: str
    message: str


class ApiError(BaseModel):
    error: ErrorDetail


class ApiException(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.error = ApiError(error=ErrorDetail(code=code, message=message))
        self.headers = headers

    def response(self) -> JSONResponse:
        return JSONResponse(self.error.model_dump(), self.status_code, headers=self.headers)


VALIDATION_ERROR = {"model": ApiError, "description": "Некорректные данные запроса"}
SERVICE_UNAVAILABLE = {"model": ApiError, "description": "База данных временно недоступна"}
