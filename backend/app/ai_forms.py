from base64 import b64encode
from collections.abc import AsyncIterator
from dataclasses import dataclass
from io import BytesIO
from uuid import UUID

from fastapi import Request
from PIL import Image
from python_multipart.exceptions import MultipartParseError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.errors import VALIDATION_ERROR, ApiError, ApiException

MAX_TEXT = 12000
MAX_FILES = 3
MAX_FILE = 5 * 1024 * 1024
# Allow room for UTF-8 text, multipart headers and boundaries.
MAX_REQUEST = MAX_FILES * MAX_FILE + 1024 * 1024
IMAGE_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}

FORM_ERRORS = {
    400: {"model": ApiError, "description": "Некорректный multipart-запрос или скриншот"},
    413: {"model": ApiError, "description": "Превышен лимит размера или числа файлов"},
    422: VALIDATION_ERROR,
}


@dataclass(frozen=True)
class AiForm:
    text: str
    images: list[str]
    extra_id: UUID | None


def multipart_body(id_field: str | None = None, *, required: bool = False) -> dict:
    properties = {
        "text": {"type": "string", "maxLength": MAX_TEXT},
        "files": {"type": "array", "maxItems": MAX_FILES, "items": {"type": "string", "format": "binary"}},
    }
    if id_field:
        properties[id_field] = {"type": "string", "format": "uuid"}
    schema = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
        "anyOf": [{"required": ["text"]}, {"required": ["files"]}],
    }
    if required:
        schema["required"] = [id_field]
    return {"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": schema}}}}


def file_limit() -> ApiException:
    return ApiException(413, "FILE_TOO_LARGE", "Можно отправить до трёх файлов размером до 5 MiB каждый")


async def limited_stream(request: Request) -> AsyncIterator[bytes]:
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_REQUEST:
            raise file_limit()
        yield chunk


def image_data_url(data: bytes) -> str:
    try:
        with Image.open(BytesIO(data), formats=list(IMAGE_MIME)) as image:
            mime = IMAGE_MIME[image.format]
            if image.width * image.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError("Image exceeds pixel limit")
            image.verify()
        with Image.open(BytesIO(data), formats=list(IMAGE_MIME)) as image:
            image.load()
    except (OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError):
        raise ApiException(400, "BAD_INPUT", "Отправьте корректное изображение PNG, JPEG или WebP") from None
    return f"data:{mime};base64,{b64encode(data).decode('ascii')}"


async def read_ai_form(request: Request, id_field: str | None = None, *, required: bool = False) -> AiForm:
    bad_form = ApiException(400, "BAD_INPUT", "Проверьте поля запроса multipart/form-data")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise bad_form
    parser = MultiPartParser(
        request.headers, limited_stream(request), max_files=MAX_FILES,
        max_fields=2 if id_field else 1, max_part_size=4 * MAX_TEXT,
    )
    try:
        form = await parser.parse()
    except MultiPartException as exc:
        if exc.message.startswith("Too many files."):
            raise file_limit() from None
        if exc.message.startswith("Part exceeded maximum size"):
            raise ApiException(422, "VALIDATION_ERROR", "Текст должен содержать до 12000 символов") from None
        raise bad_form from None
    except MultipartParseError:
        raise bad_form from None

    try:
        fields = {}
        files = []
        for name, value in form.multi_items():
            if name == "files" and isinstance(value, UploadFile):
                files.append(value)
            elif name in ("text", id_field) and isinstance(value, str) and name not in fields:
                fields[name] = value
            else:
                raise bad_form

        text = fields.get("text", "").strip()
        if len(text) > MAX_TEXT or "\x00" in text or not (text or files):
            raise ApiException(422, "VALIDATION_ERROR", "Введите текст до 12000 символов или добавьте скриншот")
        extra_id = None
        if id_field and (required or id_field in fields):
            try:
                extra_id = UUID(fields.get(id_field, ""))
            except ValueError:
                raise ApiException(422, "VALIDATION_ERROR", f"Укажите действительный {id_field}") from None
        if any(file.size > MAX_FILE for file in files):
            raise file_limit()
        images = [await run_in_threadpool(image_data_url, await file.read()) for file in files]
        return AiForm(text, images, extra_id)
    finally:
        await form.close()
