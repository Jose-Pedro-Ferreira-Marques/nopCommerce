import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export let options = {
  vus: 2,
  duration: '15s',
};

const BASE_URL = 'http://localhost';
const PRODUCT_URL = '/build-your-own-computer';
const PRODUCT_ID = 1;

// Headers para AJAX (add to cart)
const ajaxHeaders = {
  'Accept': '*/*',
  'Accept-Language': 'pt-PT,pt;q=0.8,en;q=0.5,en-US;q=0.3',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Origin': 'http://localhost',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0'
};

// Headers para formulários normais
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
  }
  
  // Atualizar cookies
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }
  
  return { success: registered, email: email };
}

export default function () {
  let res;
  let cookies = {};
  let token = '';
  
  // 1. Homepage
  res = http.get(BASE_URL + '/');
  check(res, { 'homepage status 200': (r) => r.status === 200 });
  cookies = res.cookies;
  console.log(`🍪 Cookies após homepage:`, Object.keys(cookies).length);

  // 2. Registrar novo usuário
  let registration = registerUser(cookies, __VU);
  check(registration, { 'registration successful': () => registration.success });
  if (!registration.success) return;
  console.log(`🍪 Cookies após registro:`, Object.keys(cookies).length);

  // 3. Product page
  res = http.get(BASE_URL + PRODUCT_URL, {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'product page status 200': (r) => r.status === 200 });
  token = extractToken(res.body);
  console.log(`🔑 Token extraído da product page: ${token ? 'SIM' : 'NÃO'}`);

  // 4. Add to cart
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
  
  res = http.post(BASE_URL + `/addproducttocart/details/${PRODUCT_ID}/1`, payloadString, {
    headers: ajaxHeaders,
    cookies: cookies
  });
  
  if (res.status === 200) {
    try {
      let body = JSON.parse(res.body);
      check(body, { 'add to cart success': () => body.success === true });
      console.log(`🛒 Produto adicionado ao carrinho`);
    } catch (e) {
      console.log(`❌ Erro ao parsear resposta do add to cart`);
    }
  }

  // Atualizar cookies
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  // 5. Cart page
  res = http.get(BASE_URL + '/cart', {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'cart page status 200': (r) => r.status === 200 });
  console.log(`🍪 Cookies após cart page:`, Object.keys(cookies).length);

  // Atualizar cookies
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  // 5.5 - Checkout attributes (gift wrapping)
  console.log(`🔍 Enviando checkout attributes...`);

  let checkoutAttributesData = {
      'checkout_attribute_1': '1',  // 1 = No gift wrapping
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
          
          // Extrair novo token se disponível
          if (body.selectedcheckoutattributesssectionhtml) {
              console.log(`📦 Gift wrapping: ${body.selectedcheckoutattributesssectionhtml}`);
          }
      } catch (e) {
          console.log(`❌ Erro ao parsear resposta`);
      }
  }

  // Atualizar cookies
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  // 6. Checkout page
  res = http.get(BASE_URL + '/onepagecheckout', {
    headers: formHeaders,
    cookies: cookies
  });
  check(res, { 'checkout page status 200': (r) => r.status === 200 });
  
  token = extractToken(res.body);
  console.log(`🔑 Token extraído da checkout page: ${token ? 'SIM' : 'NÃO'}`);
  console.log(`🍪 Cookies após checkout page:`, Object.keys(cookies).length);

  // Atualizar cookies
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  // 7. Billing address
// 7. Billing address
  let billingData = {
    'ShipToSameAddress': ['true', 'false'],
    'billing_address_id': '0',
    'BillingNewAddress.Id': '0',
    'BillingNewAddress.FirstName': 'John',
    'BillingNewAddress.LastName': 'Smith',
    'BillingNewAddress.Email': registration.email,
    'BillingNewAddress.Company': 'a',
    'BillingNewAddress.CountryId': '237',
    'BillingNewAddress.StateProvinceId': '1799',  // Mudei de 0 para 1799
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
  
  // 7. Billing address
  console.log(`🔍 Enviando billing address...`);
  res = http.post(BASE_URL + '/checkout/OpcSaveBilling', billingString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });

  console.log(`✅ Billing saved - Status: ${res.status}`);

  // ATUALIZAR COOKIES
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após billing:`, Object.keys(cookies).length);
  }

  // Extrair billing_address_id da resposta
  if (res.body && typeof res.body === 'string') {
    try {
      let body = JSON.parse(res.body);
      // A resposta pode conter o ID do endereço criado
      console.log(`📦 Resposta billing:`, JSON.stringify(body));
      
      // Se houver um campo com o ID do endereço, capture-o
      // (o nome do campo pode variar)
    } catch (e) {
      console.log(`❌ Erro ao parsear resposta do billing`);
    }
  }
  // 8. Shipping method
  let shippingData = {
    'shippingoption': 'Ground___Shipping.FixedRate',
    '__RequestVerificationToken': token
  };
  
  let shippingString = Object.entries(shippingData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  // 8. Shipping method - CORRIGIDO
  console.log(`🔍 Enviando shipping method...`);
  res = http.post(BASE_URL + '/checkout/OpcSaveShippingMethod', shippingString, {  // MUDADO
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });
  
  check(res.status === 200 || res.status === 302, { 'save shipping success': () => true });
  console.log(`✅ Shipping method saved - Status: ${res.status}`);
  
  // ATUALIZAR COOKIES
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após shipping:`, Object.keys(cookies).length);
  }
  
  if (res.body && typeof res.body === 'string') {
    let newToken = extractToken(res.body);
    if (newToken) {
      token = newToken;
      console.log(`🔄 Token atualizado após shipping`);
    }
  }

  // 9. Payment method
  let paymentData = {
    'paymentmethod': 'Payments.CheckMoneyOrder',
    '__RequestVerificationToken': token
  };

  let paymentString = Object.entries(paymentData)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  console.log(`🔍 Enviando payment method para ${BASE_URL}/checkout/OpcSavePaymentMethod`);
  res = http.post(BASE_URL + '/checkout/OpcSavePaymentMethod', paymentString, {
    headers: formHeaders,
    cookies: cookies,
    followRedirects: false
  });

  console.log(`📊 Status payment method: ${res.status}`);

  // ATUALIZAR COOKIES
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após payment method:`, Object.keys(cookies).length);
  }

  if (res.status === 200) {
    try {
        let body = JSON.parse(res.body);
        console.log(`✅ Payment method saved`);
        
        if (body.update_section && body.update_section.html) {
            let newToken = extractToken(body.update_section.html);
            if (newToken) {
                token = newToken;
                console.log(`🔄 Token atualizado do HTML do payment method`);
            }
        }
    } catch (e) {
        console.log(`❌ Erro ao parsear resposta: ${res.body.substring(0, 100)}`);
    }
  } else {
    console.log(`❌ Payment method failed with status ${res.status}`);
  }

  check(res.status === 200, { 'save payment success': () => true });

  // 9.5 - Payment info com checkout attributes
  console.log(`🔍 Enviando payment info com gift wrapping...`);

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

  // ATUALIZAR COOKIES
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
    console.log(`🍪 Cookies atualizados após payment info:`, Object.keys(cookies).length);
  }

  if (res.status === 200) {
      try {
          let body = JSON.parse(res.body);
          console.log(`✅ Payment info saved com gift wrapping = No`);
          
          if (body.update_section && body.update_section.html) {
              let newToken = extractToken(body.update_section.html);
              if (newToken) {
                  token = newToken;
                  console.log(`🔄 Token atualizado`);
              }
          }
      } catch (e) {
          console.log(`❌ Erro ao parsear resposta`);
      }
  }

  // 10. Confirm order
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
  console.log(`📋 Headers:`, JSON.stringify(res.headers));
  console.log(`📝 Body (primeiros 200 chars): ${res.body.substring(0, 200)}`);

  // ATUALIZAR COOKIES (última vez)
  if (res.cookies) {
    cookies = { ...cookies, ...res.cookies };
  }

  // Verificar se é realmente um sucesso
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

  check(confirmSuccess, { 'order confirmation success': () => confirmSuccess });

  sleep(randomIntBetween(2, 4));
}