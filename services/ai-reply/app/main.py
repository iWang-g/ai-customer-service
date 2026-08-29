from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from app.core.config import get_settings
from app.pipeline import build_reply
from app.provider import generate_with_provider
from app.schemas import ReplyRequest, ReplyResponse, ShopSummaryRequest, ShopSummaryResponse
import json


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai-reply"}

    @app.post("/api/v1/replies/preview", response_model=ReplyResponse)
    async def preview(request: ReplyRequest) -> ReplyResponse:
        return await build_reply(request)

    @app.post("/api/v1/replies/decide", response_model=ReplyResponse)
    async def decide(request: ReplyRequest) -> ReplyResponse:
        return await build_reply(request)

    @app.post("/api/v1/shop-summaries/generate", response_model=ShopSummaryResponse)
    async def generate_shop_summary(request: ShopSummaryRequest) -> ShopSummaryResponse:
        products = [
            {
                "title": str(item.get("title") or "").strip(),
                "goods_id": str(item.get("goods_id") or "").strip(),
                "price_label": str(item.get("price_label") or "").strip(),
            }
            for item in request.products
            if isinstance(item, dict) and str(item.get("title") or "").strip()
        ]
        system = (
            "你是电商店铺资料整理助手。根据真实在售商品标题，生成店铺资料摘要。"
            "只返回 JSON，不要 Markdown，不要虚构商品，不要输出网址。"
            'JSON 字段必须是 shop_intro 和 on_sale_products，都是简洁中文字符串。'
            "shop_intro 描述店铺主营品类和风格，不超过80字。"
            "on_sale_products 用分号分隔代表性商品标题，保留商品真实名称，不超过1200字。"
        )
        user = (
            f"店铺名：{request.shop_name or '未知店铺'}\n"
            f"在售商品：{json.dumps(products, ensure_ascii=False)}"
        )
        generated, provider = await generate_with_provider(
            system=system,
            user=user,
            provider_config=request.provider_config,
            temperature=0.2,
            json_mode=True,
            stage="shop_summary",
        )
        try:
            value = json.loads(generated)
        except (TypeError, ValueError):
            value = {}
        return ShopSummaryResponse(
            shop_intro=str(value.get("shop_intro") or f"{request.shop_name or '本店'}主营店铺在售商品。").strip(),
            on_sale_products=str(value.get("on_sale_products") or "；".join(item["title"] for item in products)).strip(),
            provider=provider,
        )

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
