const Twilio = require('twilio');
const nodeFetch = require('node-fetch');
const { URLSearchParams } = require('url');
const uuidv1 = require('uuid/v1');
const { Base64 } = require('js-base64');

const verifyEventProps = (event) => {
  const result = {
    success: false,
  };

  const { fromNumber, toName, toNumber } = event;

  if (!fromNumber) {
    result.message = "Missing 'fromNumber' in request body";
  } else if (!toName) {
    result.message = "Missing 'toName' in request body";
  } else if (!toNumber) {
    result.message = "Missing 'toNumber' in request body";
  } else {
    result.success = true;
  }

  return result;
};

const getFlexFlow = (context, fromNumber) => new Promise(async (resolve, reject) => {
  const flexFlowsApi = 'https://flex-api.twilio.com/v1/FlexFlows';

  console.log(`Finding Flex Flow matching ${fromNumber} with integration_type of task`);
  let fetchResponse;
  try {
    fetchResponse = await nodeFetch(flexFlowsApi, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Base64.encode(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`)}`,
      },
    });
  } catch (error) {
    console.error('Error fetching Flex Flows.', error);
    return reject(error);
  }
  let jsonResponse;
  try {
    jsonResponse = await fetchResponse.json();
  } catch (error) {
    console.error('Error converting fetch response to JSON.', error);
    return reject(error);
  }

  const flexFlows = jsonResponse && jsonResponse.flex_flows;
  if (!flexFlows || flexFlows.length === 0) {
    console.error('No Flex flows returned from fetch request');
    return resolve();
  }

  let flexFlow;
  for (let i = 0; i < flexFlows.length; i++) {
    const flow = flexFlows[i];
    if (flow.contact_identity === fromNumber && flow.integration_type === 'task') {
      flexFlow = flow;
      break;
    }
  }
  return resolve(flexFlow);
});

const createChatChannelWithTask = (
  context, flexFlowSid, identity, toNumber, toName, fromNumber,
) => new Promise(async (resolve, reject) => {
  const flexChannelsApi = 'https://flex-api.twilio.com/v1/Channels';

  const urlParams = new URLSearchParams();
  urlParams.append('FlexFlowSid', flexFlowSid);
  urlParams.append('Target', toNumber);
  urlParams.append('Identity', identity);
  urlParams.append('ChatUserFriendlyName', toName);
  urlParams.append('ChatFriendlyName', `SMS${toNumber}`);
  const taskAttributes = {
    to: toNumber,
    direction: 'outbound',
    name: toName,
    from: fromNumber,
    targetWorkerPhone: fromNumber,
    autoAnswer: true,
  };
  urlParams.append('TaskAttributes', JSON.stringify(taskAttributes));

  let fetchResponse;
  try {
    fetchResponse = await nodeFetch(flexChannelsApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Base64.encode(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`)}`,
      },
      body: urlParams,
    });
  } catch (error) {
    console.error('Error creating chat channel.', error);
    return reject(error);
  }
  let jsonResponse;
  try {
    jsonResponse = await fetchResponse.json();
  } catch (error) {
    console.error('Error converting fetch response to JSON.', error);
    return reject(error);
  }

  return resolve(jsonResponse);
});

const createProxySession = (
  context, chatChannelSid, toNumber, toName, fromNumber,
) => new Promise(async (resolve, reject) => {
  const client = Twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
  const proxyClient = client.proxy.services(context.TWILIO_PROXY_SERVICE_SID);

  let proxySession;
  try {
    const participants = [
      {
        Identifier: toNumber,
        ProxyIdentifier: fromNumber,
        FriendlyName: toName,
      }, {
        Identifier: chatChannelSid,
        ProxyIdentifier: fromNumber,
        FriendlyName: toName,
      },
    ];
    proxySession = await proxyClient.sessions.create({
      uniqueName: chatChannelSid,
      mode: 'message-only',
      participants: JSON.stringify(participants),
    });
  } catch (error) {
    console.error('Error creating proxy session.', error);
    return reject(error);
  }

  return resolve(proxySession);
});

exports.handler = async function(context, event, callback) {
  console.log('Received event with properties:');
  Object.keys(event).forEach((key) => {
    console.log(`--${key}:`, event[key]);
  });

  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'OPTIONS POST');
  response.appendHeader('Content-Type', 'application/json');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');

  const eventCheck = verifyEventProps(event);
  if (!eventCheck.success) {
    console.log('Event property check failed.', eventCheck.message);
    response.setStatusCode(400);
    response.setBody({ status: 400, message: eventCheck.message });
    return callback(null, response);
  }

  const { fromNumber, toName, toNumber } = event;

  let flexFlow;
  try {
    flexFlow = await getFlexFlow(context, fromNumber);
  } catch (error) {
    response.setStatusCode(error && error.status);
    response.setBody(error);
    return callback(null, response);
  }
  if (!flexFlow) {
    response.setStatusCode(500);
    response.setBody({ message: 'Unable to find matching Flex Flow' });
    return callback(null, response);
  }

  const chatServicesSid = flexFlow.chat_service_sid;
  const flexFlowSid = flexFlow.sid;
  console.log('Matching flow chat service SID:', chatServicesSid);
  console.log('Matching flex flow sid:', flexFlowSid);

  const identity = uuidv1();

  let chatChannel;
  try {
    chatChannel = await createChatChannelWithTask(
      context, flexFlowSid, identity, toNumber, toName, fromNumber,
    );
  } catch (error) {
    response.setStatusCode(error && error.status);
    response.setBody(error);
    return callback(null, response);
  }
  if (!chatChannel) {
    response.setStatusCode(500);
    response.setBody({ message: 'Failed to create chat channel' });
    return callback(null, response);
  }
  if (!chatChannel.sid) {
    response.setStatusCode(chatChannel.status);
    response.setBody(chatChannel);
    return callback(null, response);
  }
  console.log('Chat channel created:');
  const responseBody = { chatChannel: { identity } };
  Object.keys(chatChannel).forEach((key) => {
    console.log(`${key}: ${chatChannel[key]}`);
    responseBody.chatChannel[key] = chatChannel[key];
  });

  let proxySession;
  try {
    proxySession = await createProxySession(
      context, chatChannel.sid, toNumber, toName, fromNumber,
    );
  } catch (error) {
    response.setStatusCode(error && error.status);
    response.setBody(error);
    return callback(null, response);
  }
  if (!proxySession) {
    response.setStatusCode(500);
    response.setBody({ message: 'Failed to create proxy session' });
    return callback(null, response);
  }
  if (!proxySession.sid) {
    response.setStatusCode(proxySession.status);
    response.setBody(proxySession);
    return callback(null, response);
  }
  console.log('Proxy session created:');
  responseBody.proxySession = {};
  Object.keys(proxySession).forEach((key) => {
    if (key === '_version' || key === '_solution') {
      return;
    }
    console.log(`${key}: ${proxySession[key]}`);
    responseBody.proxySession[key] = proxySession[key];
  });

  response.setBody(responseBody);
  return callback(null, response);
};
