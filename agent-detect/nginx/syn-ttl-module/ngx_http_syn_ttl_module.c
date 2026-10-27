/*
 * ngx_http_syn_ttl_module
 *
 * Exposes the IP TTL (IPv4) or hop limit (IPv6) of the client's TCP SYN as
 * $syn_ttl, plus an estimated hop count as $syn_hops.
 *
 * Reads c->saved_syn, which is filled by FoxIO's nginx-tcp-save-syn.patch when
 * "tcp_save_syn on;" is set. Without that patch the variables are empty.
 */

#include <ngx_config.h>
#include <ngx_core.h>
#include <ngx_http.h>

static ngx_int_t ngx_http_syn_ttl_add_variables(ngx_conf_t *cf);

static ngx_http_module_t ngx_http_syn_ttl_module_ctx = {
    ngx_http_syn_ttl_add_variables, NULL, NULL, NULL, NULL, NULL, NULL, NULL
};

ngx_module_t ngx_http_syn_ttl_module = {
    NGX_MODULE_V1, &ngx_http_syn_ttl_module_ctx, NULL, NGX_HTTP_MODULE,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NGX_MODULE_V1_PADDING
};

#if (NGX_HAVE_TCP_SAVE_SYN)
static ngx_int_t
ngx_http_syn_ttl_read(ngx_connection_t *c)
{
    const u_char *b = c->saved_syn.data;
    size_t        n = c->saved_syn.len;

    if (b == NULL || n < 20) {
        return -1;
    }
    switch (b[0] >> 4) {
    case 4:  return b[8];                 /* IPv4 TTL */
    case 6:  return n >= 40 ? b[7] : -1;  /* IPv6 hop limit */
    default: return -1;
    }
}
#endif

static ngx_int_t
ngx_http_syn_ttl_variable(ngx_http_request_t *r, ngx_http_variable_value_t *v,
    uintptr_t data)
{
#if (NGX_HAVE_TCP_SAVE_SYN)
    ngx_int_t  ttl, initial;
    u_char    *p;

    ttl = ngx_http_syn_ttl_read(r->connection);
    if (ttl < 0) {
        v->not_found = 1;
        return NGX_OK;
    }
    p = ngx_pnalloc(r->pool, NGX_INT_T_LEN);
    if (p == NULL) {
        return NGX_ERROR;
    }
    if (data == 1) {              /* $syn_hops: distance from nearest initial TTL */
        initial = ttl <= 64 ? 64 : (ttl <= 128 ? 128 : 255);
        ttl = initial - ttl;
    }
    v->len = ngx_sprintf(p, "%i", ttl) - p;
    v->data = p;
    v->valid = 1;
    v->no_cacheable = 1;
    v->not_found = 0;
    return NGX_OK;
#else
    v->not_found = 1;
    return NGX_OK;
#endif
}

static ngx_http_variable_t ngx_http_syn_ttl_vars[] = {
    { ngx_string("syn_ttl"),  NULL, ngx_http_syn_ttl_variable, 0,
      NGX_HTTP_VAR_NOCACHEABLE, 0 },
    { ngx_string("syn_hops"), NULL, ngx_http_syn_ttl_variable, 1,
      NGX_HTTP_VAR_NOCACHEABLE, 0 },
      ngx_http_null_variable
};

static ngx_int_t
ngx_http_syn_ttl_add_variables(ngx_conf_t *cf)
{
    ngx_http_variable_t *var, *v;

    for (v = ngx_http_syn_ttl_vars; v->name.len; v++) {
        var = ngx_http_add_variable(cf, &v->name, v->flags);
        if (var == NULL) {
            return NGX_ERROR;
        }
        var->get_handler = v->get_handler;
        var->data = v->data;
    }
    return NGX_OK;
}
