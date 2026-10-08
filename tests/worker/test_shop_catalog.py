import contextlib
import io
import json
import unittest
from unittest.mock import patch

import requests

import duo_killer
from shop_catalog import DUO_URL, STORE_URL, duo_status, query_duo, query_store, recommendations, series_skus


def fixture():
    cards = {"items": [
        {"textLink": {"url": "/shop/buy-iphone"}, "headline": "导航不算推荐"},
        {"headline": "示例&nbsp;手机", "textLink": {
            "url": "/shop/buy-iphone/example", "omnitureData": {"partNumber": "EXAMPLE_MAIN"}}},
        {"view": "recommendationCard", "products": [
            {"part": "ABCDEFE/A", "title": "保护壳", "price": "price1",
             "productDetailsUrl": "/shop/product/abcdefe/a", "dimensions": {"color": "blue"}}],
         "dictionaries": {"price": {"price1": {"currentPrice": {"raw_amount": "99.00"}, "priceCurrency": "CNY"}}}}
    ]}
    return '<script>window.pageLevelData.slots.push({shelfTitleA11yText: `上新了`, cards: ' + json.dumps(cards) + '});</script>'


def reply(html, status=200):
    r = requests.Response()
    r.status_code = status
    r._content = html.encode()
    return r


class ShopTests(unittest.TestCase):
    def test_recommendations_keep_sku_suffix_and_skip_navigation(self):
        result = recommendations(fixture())
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["name"], "示例 手机")
        self.assertEqual(result[0]["kind"], "series")
        self.assertEqual(result[1]["skus"][0]["sku"], "ABCDEFE/A")
        self.assertEqual(result[1]["skus"][0]["price"], "99.00")
        self.assertEqual(result[1]["stock_status"], "not_queried")

    def test_metrics_not_whole_page_sku_scan(self):
        product = {"partNumber": "ABCDECH/A", "name": "手机蓝色", "price": {"fullPrice": 1999}}
        html = '<script id="metrics" type="application/json">' + json.dumps({"products": [product, product]}) + '</script>'
        html += '<script>{"partNumber":"WRONGCH/A"}</script>'
        result = series_skus(html)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["sku"], "ABCDECH/A")

    def test_failed_series_is_partial_not_out_of_stock(self):
        def fetch(session, stage, url, **kwargs):
            return reply(fixture()) if url == STORE_URL else reply("blocked", 541)
        result = query_store(fetch)
        self.assertTrue(result["success"])
        self.assertTrue(result["partial"])
        self.assertEqual(result["sku_count"], 1)
        self.assertEqual(result["items"][0]["sku_status"], "unresolved")
        self.assertEqual(result["items"][0]["stock_status"], "not_queried")

    def test_missing_recommendations_is_error(self):
        with self.assertRaises(ValueError):
            recommendations("<html>Page Not Found</html>")

    def test_cli_does_not_authenticate_or_save_credentials(self):
        with patch("shop_catalog.query_store", return_value={"success": True, "items": []}) as query, \
                patch.object(duo_killer, "authenticate") as auth, \
                patch.object(duo_killer, "save_auth") as save, \
                patch.object(duo_killer, "login") as login, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            duo_killer.main(["-s"])
        query.assert_called_once_with(duo_killer.request_get, phone_only=False)
        auth.assert_not_called()
        save.assert_not_called()
        login.assert_not_called()
        self.assertTrue(json.loads(output.getvalue())["success"])

    def test_query_cannot_combine_with_purchase(self):
        for args in (["-s", "-p"], ["-s", "-a"], ["-s", "--sms"], ["--phone"], ["-l", "--phone"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                duo_killer.main(args)
            self.assertEqual(caught.exception.code, 2)

    def test_phone_filter_runs_before_fetching_other_series(self):
        items = recommendations(fixture())
        items[1]["name"] = "iPhone 手机壳"
        items.append({**items[0], "name": "Mac", "url": "https://www.apple.com.cn/shop/buy-mac/example"})
        visited = []

        def fetch(session, stage, url, **kwargs):
            visited.append(url)
            return reply(fixture() if url == STORE_URL else '<script id="metrics">{"products": []}</script>')

        with patch("shop_catalog.recommendations", return_value=items):
            result = query_store(fetch, phone_only=True)
        self.assertEqual(result["filter"], "phone")
        self.assertEqual(result["count"], 1)
        self.assertEqual(visited, [STORE_URL, "https://www.apple.com.cn/shop/buy-iphone/example"])

    def test_phone_cli_passes_filter(self):
        with patch("shop_catalog.query_store", return_value={"success": True}) as query, \
                contextlib.redirect_stdout(io.StringIO()):
            duo_killer.main(["-s", "--phone"])
        query.assert_called_once_with(duo_killer.request_get, phone_only=True)

    def test_duo_status_uses_per_sku_flags_not_names_or_dates(self):
        products = [
            {"partNumber": "AAAAACH/A", "familyType": "iphoneduo", "comingSoon": True},
            {"partNumber": "BBBBBCH/A", "familyType": "iphoneduo", "comingSoon": False},
            {"partNumber": "CCCCCCH/A", "familyType": "iphoneduo"},
            {"partNumber": "DDDDDCH/A", "familyType": "iphone17", "comingSoon": True},
        ]
        html = '<script>window.PRODUCT_SELECTION_BOOTSTRAP = {productSelectionData: ' + json.dumps({"products": products}) + '};</script>'
        html += '<script>window.pageLevelData.productHeader = {"header":"<h1>Duo</h1> 等待预购"};</script>'
        result = duo_status(html)
        self.assertEqual(result["sku_count"], 3)
        self.assertEqual([x["can_add_to_bag"] for x in result["items"]], [False, None, None])
        self.assertEqual(result["items"][0]["purchase_status"], "not_yet_open")
        self.assertTrue(result["partial"])
        self.assertEqual(result["purchase_message"], "Duo 等待预购")
        self.assertTrue(all(x["stock_status"] == "not_queried" for x in result["items"]))

    def test_duo_missing_data_is_error_not_unavailable(self):
        for html in ("<html>blocked</html>", fixture()):
            with self.assertRaises(ValueError):
                duo_status(html)

    def test_duo_queries_only_public_product_page_and_rejects_http_errors(self):
        def fetch(session, stage, url, **kwargs):
            self.assertEqual(url, DUO_URL)
            self.assertFalse(kwargs["allow_redirects"])
            self.assertEqual(len(session.cookies), 0)
            return reply("blocked", 541)
        with self.assertRaisesRegex(ValueError, "HTTP 541"):
            query_duo(fetch)

    def test_duo_cli_does_not_authenticate_or_mutate_bag(self):
        with patch("shop_catalog.query_duo", return_value={"success": True}) as query, \
                patch.object(duo_killer, "authenticate") as auth, \
                patch.object(duo_killer, "save_auth") as save, \
                patch.object(duo_killer, "add_to_bag") as add, \
                contextlib.redirect_stdout(io.StringIO()):
            duo_killer.main(["-s", "--duo"])
        query.assert_called_once_with(duo_killer.request_get)
        auth.assert_not_called()
        save.assert_not_called()
        add.assert_not_called()

    def test_duo_requires_shop_and_excludes_other_filters(self):
        for args in (["--duo"], ["-a", "--duo"], ["-s", "--phone", "--duo"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                duo_killer.main(args)
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
