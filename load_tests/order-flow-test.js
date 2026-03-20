import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export let options = {
  vus: 5,  
  duration: '30s',  
};

const BASE_URL = 'http://localhost';

const PRODUCTS = [
  { url: '/build-your-own-computer', id: 1, name: 'Build Your Own Computer' },
  { url: '/simple-product', id: 2, name: 'Simple Product' },
  { url: '/digital-download', id: 3, name: 'Digital Download' },
  { url: '/gift-card', id: 4, name: 'Gift Card' }
];

const ajaxHeaders = {
  'Accept': '*/*',
  'Accept-Language': 'pt-PT,pt;q=0.8,en;q=0.5,en-US;q=0.3',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Origin': 'http://localhost',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0'
};

const formHeaders = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-PT,pt;q=0.8,en;q=0.5,en-US;q=0.3',
  'Content-Type': 'application/x-www-form-urlencoded',
  'Origin': 'http://localhost',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0'
};

function extractToken(html) {
  const match = html.match(/<input.*?name="__RequestVerificationToken".*?value="([^"]+)"/);
  return match ? match[1] : '';
}

function registerUser(cookies, vuId) {
  let res = http.get(BASE_URL + '/register', {
    headers: formHeaders,
    cookies: cookies
  });
  
  let token = extractToken(res.body);
  let timestamp = Date.now();
  let email = `user${vuId}_${timestamp}@test.com`;
  
  let registerData = {
    'FirstName': 'Test',
    'LastName': 'User',
    'Email': email,
    'Password': 'Test123!',
    'ConfirmPassword': 'Test123!',
    'Gender': 'Male',
    'DateOfBirthDay': '1',
    'DateOfBirthMonth': '1',
    'DateOfBirthYear': '1990',
    'Company': 'Test Company',
    'Newsletter': 'true',
    'AcceptPrivacyPolicyEnabled': 'true',
    '__RequestVerificationToken': token
  };
  
  let registerString = Object.entries(registerData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  res = http.post(BASE_URL + '/register', registerString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: true
  });
  
  let registered = res.status === 200 && (res.url === BASE_URL + '/' || res.url.includes('registerresult'));
  
  if (registered) {
    console.log(`✅ Usuário registrado: ${email}`);
  } else {
    console.log(`❌ Falha no registro: ${email}`);
  }
  
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }
  
  return { success: registered, email: email };
}

function shouldFail(stepName, failRate = 0.2) {
  const random = Math.random();
  const fail = random < failRate;
  if (fail) {
    console.log(`💥 SIMULATED FAILURE at step: ${stepName} (random: ${random.toFixed(2)})`);
  }
  return fail;
}

export default function () {
  let res;
  let cookies = {};
  let token = '';
  
  const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  console.log(`📦 Selected product: ${product.name} (ID: ${product.id})`);
  
  if (shouldFail('Homepage', 0.05)) {
    console.log(`❌ Simulated failure - skipping this user`);
    return;
  }
  
  res = http.get(BASE_URL + '/');
  check(res, { 'homepage status 200': (r) => r.status === 200 });
  cookies = res.cookies;
  console.log(`🍪 Cookies após homepage:`, Object.keys(cookies).length);

  let registration = registerUser(cookies, __VU);
  check(registration, { 'registration successful': () => registration.success });
  if (!registration.success) return;
  console.log(`🍪 Cookies após registro:`, Object.keys(cookies).length);
  
  if (shouldFail('After Registration', 0.1)) {
    console.log(`❌ Simulated failure after registration - stopping`);
    return;
  }

  res = http.get(BASE_URL + product.url, {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'product page status 200': (r) => r.status === 200 });
  token = extractToken(res.body);
  console.log(`🔑 Token extraído da product page: ${token ? 'SIM' : 'NÃO'}`);
  
  if (shouldFail('Product Page', 0.05)) {
    console.log(`❌ Simulated failure on product page - stopping`);
    return;
  }

  let addToCartPayload = {
    'product_attribute_1': '2',
    'product_attribute_2': '3',
    'product_attribute_3': '6',
    'product_attribute_4': '8',
    'product_attribute_5': '10',
    'addtocart_1.EnteredQuantity': '1',
    '__RequestVerificationToken': token
  };
  
  let payloadString = Object.entries(addToCartPayload)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  res = http.post(BASE_URL + `/addproducttocart/details/${product.id}/1`, payloadString, {
    headers: ajaxHeaders,
    cookies: cookies
  });
  
  if (shouldFail('Add to Cart', 0.15)) {
    console.log(`❌ Simulated failure - skipping cart and checkout`);
    return;
  }
  
  if (res.status === 200) {
    try {
      let body = JSON.parse(res.body);
      check(body, { 'add to cart success': () => body.success === true });
      console.log(`🛒 Produto adicionado ao carrinho`);
    } catch (e) {
      console.log(`❌ Erro ao parsear resposta do add to cart`);
    }
  }

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  res = http.get(BASE_URL + '/cart', {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'cart page status 200': (r) => r.status === 200 });
  console.log(`🍪 Cookies após cart page:`, Object.keys(cookies).length);

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  console.log(`🔍 Enviando checkout attributes...`);

  let checkoutAttributesData = {
      'checkout_attribute_1': '1',
      'itemquantity152': '1',
      'CountryId': '237',
      'StateProvinceId': '1828',
      'ZipPostalCode': '10021',
      'discountcouponcode': '',
      'giftcardcouponcode': '',
      '__RequestVerificationToken': token
  };

  let checkoutAttributesString = Object.entries(checkoutAttributesData)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

  res = http.post(BASE_URL + '/shoppingcart/checkoutattributechange/True?isEditable=True', checkoutAttributesString, {
      headers: formHeaders,
      cookies: cookies,
      followRedirects: false
  });

  console.log(`📊 Status checkout attributes: ${res.status}`);

  if (res.status === 200) {
      try {
          let body = JSON.parse(res.body);
          console.log(`✅ Checkout attributes saved`);
          
          if (body.selectedcheckoutattributesssectionhtml) {
              console.log(`📦 Gift wrapping: ${body.selectedcheckoutattributesssectionhtml}`);
          }
      } catch (e) {
          console.log(`❌ Erro ao parsear resposta`);
      }
  }

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  res = http.get(BASE_URL + '/onepagecheckout', {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'checkout page status 200': (r) => r.status === 200 });
  
  token = extractToken(res.body);
  console.log(`🔑 Token extraído da checkout page: ${token ? 'SIM' : 'NÃO'}`);
  console.log(`🍪 Cookies após checkout page:`, Object.keys(cookies).length);

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  let billingData = {
    'ShipToSameAddress': ['true', 'false'],
    'billing_address_id': '0',
    'BillingNewAddress.Id': '0',
    'BillingNewAddress.FirstName': 'John',
    'BillingNewAddress.LastName': 'Smith',
    'BillingNewAddress.Email': registration.email,
    'BillingNewAddress.Company': 'a',
    'BillingNewAddress.CountryId': '237',
    'BillingNewAddress.StateProvinceId': '1799',
    'BillingNewAddress.City': 'a',
    'BillingNewAddress.Address1': 'a',
    'BillingNewAddress.Address2': 'a',
    'BillingNewAddress.ZipPostalCode': 'a',
    'BillingNewAddress.PhoneNumber': 'a',
    'BillingNewAddress.FaxNumber': 'a',
    '__RequestVerificationToken': token
  };

  let billingString = 'ShipToSameAddress=true&ShipToSameAddress=false&' + 
    Object.entries(billingData)
    .filter(([key]) => key !== 'ShipToSameAddress')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  console.log(`🔍 Enviando billing address...`);
  res = http.post(BASE_URL + '/checkout/OpcSaveBilling', billingString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });

  console.log(`✅ Billing saved - Status: ${res.status}`);
  
  if (shouldFail('Billing Address', 0.1)) {
    console.log(`❌ Simulated failure at billing - stopping`);
    return;
  }

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após billing:`, Object.keys(cookies).length);
  }

  let shippingData = {
    'shippingoption': 'Ground___Shipping.FixedRate',
    '__RequestVerificationToken': token
  };
  
  let shippingString = Object.entries(shippingData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  console.log(`🔍 Enviando shipping method...`);
  res = http.post(BASE_URL + '/checkout/OpcSaveShippingMethod', shippingString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });
  
  check(res.status === 200 || res.status === 302, { 'save shipping success': () => true });
  console.log(`✅ Shipping method saved - Status: ${res.status}`);
  
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após shipping:`, Object.keys(cookies).length);
  }
  
  let paymentData = {
    'paymentmethod': 'Payments.CheckMoneyOrder',
    '__RequestVerificationToken': token
  };

  let paymentString = Object.entries(paymentData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  console.log(`🔍 Enviando payment method...`);
  res = http.post(BASE_URL + '/checkout/OpcSavePaymentMethod', paymentString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });

  console.log(`📊 Status payment method: ${res.status}`);
  
  if (shouldFail('Payment Method', 0.12)) {
    console.log(`❌ Simulated failure at payment method - stopping`);
    return;
  }

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após payment method:`, Object.keys(cookies).length);
  }

  console.log(`🔍 Enviando payment info...`);

  let paymentInfoData = {
      'checkout_attribute_1': '1',
      '__RequestVerificationToken': token
  };

  let paymentInfoString = Object.entries(paymentInfoData)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

  res = http.post(BASE_URL + '/checkout/OpcSavePaymentInfo', paymentInfoString, {
      headers: formHeaders,
      cookies: cookies,
      followRedirects: false
  });

  console.log(`📊 Status payment info: ${res.status}`);

  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após payment info:`, Object.keys(cookies).length);
  }

  let confirmData = {
    '__RequestVerificationToken': token
  };

  let confirmString = Object.entries(confirmData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  console.log(`🔍 Enviando confirmação para ${BASE_URL}/checkout/OpcConfirmOrder`);
  res = http.post(BASE_URL + '/checkout/OpcConfirmOrder', confirmString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });

  console.log(`📊 Status da confirmação: ${res.status}`);

  let confirmSuccess = false;
  if (res.status === 200) {
    try {
        let body = JSON.parse(res.body);
        if (body.success === true || body.success === 1) {
            confirmSuccess = true;
            console.log(`✅ Pedido confirmado com sucesso!`);
        } else if (body.error) {
            console.log(`❌ Pedido falhou: ${body.message}`);
        } else {
            console.log(`❌ Resposta desconhecida:`, JSON.stringify(body));
        }
    } catch (e) {
        console.log(`❌ Resposta não é JSON: ${res.body.substring(0, 100)}`);
    }
  }
  
  if (!confirmSuccess || shouldFail('Final Confirmation', 0.05)) {
    console.log(`❌ Order failed!`);
  } else {
    console.log(`✅ Order completed successfully!`);
  }

  check(confirmSuccess, { 'order confirmation success': () => confirmSuccess });

  sleep(randomIntBetween(2, 4));
}