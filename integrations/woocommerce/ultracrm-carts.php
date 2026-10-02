<?php
/**
 * Plugin Name: UltraCRM Cart Connection
 * Description: Signed cart activity and paid-order events for UltraCRM. Supports classic and block checkout.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 * Requires PHP: 7.4
 */
if (!defined('ABSPATH')) exit;
add_action('admin_menu', function () { add_options_page('UltraCRM', 'UltraCRM', 'manage_options', 'ultracrm', 'ucrm_settings'); });
add_action('admin_init', function () {
    register_setting('ucrm', 'ucrm_endpoint', ['sanitize_callback' => function ($v) { $v = esc_url_raw($v, ['https']); return preg_match('~/api/webhooks/stores/events/[a-zA-Z0-9_-]+$~', $v) ? $v : ''; }]);
    register_setting('ucrm', 'ucrm_secret', ['sanitize_callback' => 'sanitize_text_field']);
});
function ucrm_settings() {
    if (!current_user_can('manage_options')) return;
    echo '<div class="wrap"><h1>UltraCRM</h1><p>Paste the server events URL and signing secret from UltraCRM → Automations → Abandoned carts. Never put the secret in theme JavaScript.</p><form method="post" action="options.php">';
    settings_fields('ucrm');
    echo '<p>Server events URL <input class="large-text" name="ucrm_endpoint" value="' . esc_attr(get_option('ucrm_endpoint')) . '" /></p><p>Signing secret <input type="password" autocomplete="off" class="large-text" name="ucrm_secret" value="' . esc_attr(get_option('ucrm_secret')) . '" /></p>';
    submit_button(); echo '</form><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
    wp_nonce_field('ucrm_probe'); echo '<input type="hidden" name="action" value="ucrm_probe" />'; submit_button('Test signed connection');
    echo '</form><p>Last delivery: ' . esc_html(get_option('ucrm_delivery_status', 'No delivery yet')) . '</p><p>A successful connection test does not test carts or payments. Add a product, visit checkout, then complete a test payment and verify the same cart in UltraCRM. Keep WP-Cron / Action Scheduler running for retries.</p></div>';
}
function ucrm_send($body, $event_id, $attempt = 0) {
    $raw = wp_json_encode($body);
    $time = (string) time();
    $url = get_option('ucrm_endpoint'); $secret = get_option('ucrm_secret');
    if (!$url || !$secret) return false;
    $response = wp_safe_remote_post($url, ['timeout' => 12, 'redirection' => 0, 'headers' => ['Content-Type' => 'application/json', 'X-UltraCRM-Timestamp' => $time, 'X-UltraCRM-Event-Id' => $event_id, 'X-UltraCRM-Signature' => base64_encode(hash_hmac('sha256', $time . '.' . $event_id . '.' . $raw, $secret, true))], 'body' => $raw]);
    $code = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
    $ok = $code >= 200 && $code < 300;
    update_option('ucrm_delivery_status', gmdate('c') . ($ok ? ' accepted; check processing in UltraCRM' : ' FAILED HTTP ' . $code), false);
    if (!$ok && function_exists('as_schedule_single_action') && $attempt < 7 && ($code === 0 || $code === 429 || $code >= 500)) {
        as_schedule_single_action(time() + min(3600, 30 * pow(2, $attempt)), 'ucrm_deliver', [$body, $event_id, $attempt + 1], 'ultracrm');
    }
    return $ok;
}
add_action('ucrm_deliver', 'ucrm_send', 10, 3);
function ucrm_enqueue($body) { if (function_exists('as_enqueue_async_action') && get_option('ucrm_endpoint') && get_option('ucrm_secret')) as_enqueue_async_action('ucrm_deliver', [$body, wp_generate_uuid4(), 0], 'ultracrm'); }
add_action('admin_post_ucrm_probe', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('ucrm_probe'); ucrm_send(['type' => 'probe'], wp_generate_uuid4());
    wp_safe_redirect(admin_url('options-general.php?page=ultracrm')); exit;
});
function ucrm_cart_id() {
    if (!WC()->session) return '';
    $id = WC()->session->get('ucrm_cart_id');
    if (!$id) { $id = 'wc:' . wp_generate_uuid4(); WC()->session->set('ucrm_cart_id', $id); }
    return $id;
}
function ucrm_capture() {
    if (!WC()->cart || !WC()->session) return;
    WC()->cart->calculate_totals();
    $id = ucrm_cart_id(); $items = []; $restore = [];
    foreach (WC()->cart->get_cart() as $row) {
        $product = $row['data'];
        $items[] = ['name' => $product->get_name(), 'quantity' => (int) $row['quantity'], 'price' => (float) $product->get_price()];
        $restore[] = ['product_id' => $row['product_id'], 'quantity' => $row['quantity'], 'variation_id' => $row['variation_id'], 'variation' => $row['variation']];
    }
    $body = ['type' => 'cart', 'externalId' => $id, 'activityAt' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.uP'), 'items' => $items, 'total' => (float) WC()->cart->get_total('edit'), 'currency' => get_woocommerce_currency()];
    $customer = WC()->customer;
    if ($customer) {
        if ($customer->get_billing_email()) $body['email'] = $customer->get_billing_email();
        if ($customer->get_billing_phone()) $body['phone'] = $customer->get_billing_phone();
        $name = trim($customer->get_billing_first_name() . ' ' . $customer->get_billing_last_name()); if ($name) $body['name'] = $name;
    }
    // Restore only product selections, never billing data or authentication. Token expires after seven days.
    if ($restore) {
        $token = WC()->session->get('ucrm_restore');
        if (!$token) { $token = bin2hex(random_bytes(24)); WC()->session->set('ucrm_restore', $token); }
        set_transient('ucrm_restore_' . $token, ['items' => $restore, 'cart' => $id], 7 * DAY_IN_SECONDS);
        $body['checkoutUrl'] = add_query_arg('ucrm_restore', $token, home_url('/'));
    }
    ucrm_enqueue($body);
}
// Server hooks cover cart mutations, including Store API / block carts.
function ucrm_capture_after_request() { if (!has_action('shutdown', 'ucrm_capture')) add_action('shutdown', 'ucrm_capture'); }
add_action('woocommerce_add_to_cart', 'ucrm_capture_after_request', 30);
add_action('woocommerce_cart_item_removed', 'ucrm_capture_after_request', 30);
add_action('woocommerce_after_cart_item_quantity_update', 'ucrm_capture_after_request', 30);
add_action('woocommerce_cart_emptied', function () { if (WC()->session) { WC()->session->__unset('ucrm_cart_id'); WC()->session->__unset('ucrm_restore'); } });
add_action('woocommerce_checkout_update_order_review', function () { add_action('shutdown', 'ucrm_capture'); }, 30);
add_action('wc_ajax_ucrm_activity', function () {
    check_ajax_referer('ucrm_activity', 'nonce');
    if (!WC()->cart) wc_load_cart();
    ucrm_capture(); wp_send_json_success();
});
add_action('wp_footer', function () {
    if (!function_exists('WC') || !get_option('ucrm_endpoint')) return;
    $url = WC_AJAX::get_endpoint('ucrm_activity'); $nonce = wp_create_nonce('ucrm_activity');
    echo '<script>(function(){var last=0;function ping(){if(document.visibilityState!=="visible"||Date.now()-last<60000)return;last=Date.now();fetch(' . wp_json_encode($url) . ',{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"nonce="+' . wp_json_encode($nonce) . '}).catch(function(){})} ["pointerdown","keydown"].forEach(function(e){document.addEventListener(e,ping,{passive:true})});ping()})();</script>';
});
function ucrm_bind_order($order) { $id = ucrm_cart_id(); if ($id) { $order->update_meta_data('_ultracrm_cart_id', $id); $order->update_meta_data('_ultracrm_restore_token', WC()->session->get('ucrm_restore')); } }
add_action('woocommerce_checkout_create_order', 'ucrm_bind_order', 10);
add_action('woocommerce_store_api_checkout_update_order_meta', 'ucrm_bind_order', 10);
function ucrm_paid($order_id) {
    $order = wc_get_order($order_id); if (!$order || !$order->is_paid()) return;
    $id = $order->get_meta('_ultracrm_cart_id'); if (!$id) return;
    $restore_token = $order->get_meta('_ultracrm_restore_token'); if ($restore_token) delete_transient('ucrm_restore_' . $restore_token);
    ucrm_enqueue(['type' => 'order', 'externalId' => $id, 'orderId' => (string) $order->get_order_number(), 'total' => (float) $order->get_total(), 'currency' => $order->get_currency()]);
    if (WC()->session && WC()->session->get('ucrm_cart_id') === $id) { WC()->session->__unset('ucrm_cart_id'); WC()->session->__unset('ucrm_restore'); }
}
add_action('woocommerce_payment_complete', 'ucrm_paid');
add_action('woocommerce_order_status_processing', 'ucrm_paid');
add_action('woocommerce_order_status_completed', 'ucrm_paid');
add_action('template_redirect', function () {
    if (!isset($_GET['ucrm_restore']) || !function_exists('WC')) return;
    $token = sanitize_text_field(wp_unslash($_GET['ucrm_restore']));
    $saved = preg_match('/^[a-f0-9]{48}$/', $token) ? get_transient('ucrm_restore_' . $token) : false;
    if (!$saved) wp_die('This cart link expired. Please return to the shop.', 'Cart expired', ['response' => 410]);
    if (!WC()->cart) wc_load_cart();
    WC()->cart->empty_cart(); WC()->session->set('ucrm_cart_id', $saved['cart']); WC()->session->set('ucrm_restore', $token);
    foreach ($saved['items'] as $item) WC()->cart->add_to_cart($item['product_id'], $item['quantity'], $item['variation_id'], $item['variation']);
    WC()->cart->calculate_totals(); ucrm_capture(); wp_safe_redirect(wc_get_checkout_url()); exit;
});
