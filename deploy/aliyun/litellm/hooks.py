"""LiteLLM pre-call hooks for the model gateway (specs/006-litellm-gateway-billing).

1. Refuse models without both an input and an output price, so every call is
   priced and counts against Paperclip budgets (FR-004b).
2. Send the calling client's own User-Agent upstream instead of LiteLLM's
   `litellm/<version>` (FR-005). The value is copied verbatim from the incoming
   request, which LiteLLM records as metadata.user_agent; it is never invented.
"""
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger


def _has_price(params):
    return params.get("input_cost_per_token") is not None and params.get("output_cost_per_token") is not None


def _caller_user_agent(data):
    for key in ("litellm_metadata", "metadata"):
        meta = data.get(key)
        if isinstance(meta, dict) and meta.get("user_agent"):
            return meta["user_agent"]
    return None


class GatewayHooks(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        from litellm.proxy.proxy_server import llm_router

        model = data.get("model")
        if model and llm_router is not None:
            deployments = llm_router.get_model_list(model_name=model) or []
            priced = any(
                _has_price(d.get("litellm_params") or {}) or _has_price(d.get("model_info") or {}) for d in deployments
            )
            if deployments and not priced:
                raise HTTPException(status_code=400, detail=f"模型未设单价：{model}")

        user_agent = _caller_user_agent(data)
        if user_agent:
            headers = dict(data.get("extra_headers") or {})
            headers["User-Agent"] = user_agent
            data["extra_headers"] = headers
        return data


proxy_handler_instance = GatewayHooks()
