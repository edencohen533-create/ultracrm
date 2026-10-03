<?php
// Execute with PHP 7.4+; WordPress/WooCommerce boundaries are test doubles, no network or orders.
define('ABSPATH', '/'); define('DAY_IN_SECONDS', 86400);
$GLOBALS['hooks'] = []; $GLOBALS['events'] = []; $GLOBALS['transients'] = [];
function add_action($hook, $callback, $priority = 10, $args = 1) { $GLOBALS['hooks'][$hook][] = $callback; }
function has_action($hook, $callback) { return in_array($callback, $GLOBALS['hooks'][$hook] ?? [], true); }
function get_option($key) { return ['ucrm_endpoint' => 'https://crm.example.test/events', 'ucrm_secret' => 'test-only-secret'][$key] ?? ''; }
function wp_generate_uuid4() { static $n = 0; return 'test-uuid-' . ++$n; }
function as_enqueue_async_action($hook, $args, $group) { $GLOBALS['events'][] = $args[0]; }
function get_woocommerce_currency() { return 'ILS'; }
function sanitize_text_field($v) { return trim(strip_tags($v)); }
function is_email($v) { return filter_var($v, FILTER_VALIDATE_EMAIL); }
function set_transient($key, $v, $ttl) { $GLOBALS['transients'][$key] = $v; }
function delete_transient($key) { unset($GLOBALS['transients'][$key]); }
function add_query_arg($key, $v, $url) { return $url . '?' . $key . '=' . $v; }
function home_url($v) { return 'https://store.example.test' . $v; }
class TestSession { public $data = []; function get($k, $default = null) { return $this->data[$k] ?? $default; } function set($k, $v) { $this->data[$k] = $v; } function __unset($k) { unset($this->data[$k]); } }
class TestCart { public $rows = []; function get_cart() { return $this->rows; } function calculate_totals() {} function get_total($mode) { return count($this->rows) * 30; } }
class TestProduct { function get_name() { return 'Test product'; } function get_price() { return 30; } }
class TestCustomer { function __call($name, $args) { return ''; } }
$GLOBALS['wc'] = (object) ['session' => new TestSession(), 'cart' => new TestCart(), 'customer' => new TestCustomer()];
function WC() { return $GLOBALS['wc']; }
function wc_get_order($id) { return $GLOBALS['order']; }
require __DIR__ . '/../../integrations/woocommerce/ultracrm-carts.php';
function verify($value, $message) { if (!$value) throw new Exception($message); echo "PASS $message\n"; }
function latest() { return end($GLOBALS['events']); }
ucrm_capture(); verify(count($GLOBALS['events']) === 0, 'anonymous empty visits create no cart');
WC()->cart->rows = [['data' => new TestProduct(), 'quantity' => 1, 'product_id' => 12, 'variation_id' => 0, 'variation' => []]];
ucrm_capture(); $id = latest()['externalId']; $token = WC()->session->get('ucrm_restore');
verify(latest()['total'] === 30.0 && count(latest()['items']) === 1 && !isset(latest()['email']), 'anonymous cart has real items and no invented identity');
ucrm_classic_checkout('billing_email=qa%40example.test&billing_phone=0500000000&billing_first_name=Test&billing_last_name=Customer&card_number=secret');
ucrm_capture(); verify(latest()['email'] === 'qa@example.test' && latest()['phone'] === '0500000000' && latest()['name'] === 'Test Customer', 'classic checkout details captured before order');
verify(!isset(latest()['card_number']), 'unrelated checkout fields excluded');
ucrm_checkout_contact(['billing_email' => ['invalid'], 'billing_phone' => ['invalid']]);
verify(WC()->session->get('ucrm_checkout_contact')['email'] === 'qa@example.test', 'malformed nested fields ignored');
WC()->cart->rows = []; ucrm_empty_cart();
verify(latest()['externalId'] === $id && latest()['items'] === [] && latest()['total'] === 0, 'empty event closes original cart');
verify(!isset($GLOBALS['transients']['ucrm_restore_' . $token]) && !WC()->session->get('ucrm_checkout_contact'), 'empty cart clears recovery and contact snapshot');
$n = count($GLOBALS['events']); ucrm_capture(); verify(count($GLOBALS['events']) === $n, 'deferred capture after empty does not create phantom cart');
WC()->cart->rows = [['data' => new TestProduct(), 'quantity' => 1, 'product_id' => 12, 'variation_id' => 0, 'variation' => []]];
ucrm_capture(); $paidId = latest()['externalId']; verify($paidId !== $id, 'new shopping session has a new cart identity');
$GLOBALS['order'] = new class { function is_paid() { return true; } function get_meta($key) { return $key === '_ultracrm_cart_id' ? WC()->session->get('ucrm_cart_id') : WC()->session->get('ucrm_restore'); } function get_order_number() { return 'test-order'; } function get_total() { return 30; } function get_currency() { return 'ILS'; } };
ucrm_paid(1); verify(latest()['type'] === 'order' && latest()['externalId'] === $paidId, 'purchase references exact cart');
$n = count($GLOBALS['events']); ucrm_capture(); verify(count($GLOBALS['events']) === $n, 'payment followed by deferred capture creates no phantom cart');
