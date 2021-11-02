import axios, {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosResponseHeaders,
  AxiosResponseTransformer,
  Method,
} from 'axios';

export interface RetryConfig {
  maxTries?: number;
  retryOnStatus?: number[];
  backoffFactorMs?: number;
  maxBackoffMs?: number;
}

export type ErrorHandler = never | ((_: AxiosError) => never);
export type OnErrorStatus = Record<number, ErrorHandler>;

export interface RequestConfig extends Omit<AxiosRequestConfig, 'url' | 'method' | 'baseURL'> {
  rawResponse?: boolean;
  retry?: RetryConfig;
  onErrorStatus?: OnErrorStatus;
  onClientError?: ErrorHandler;
  onServerError?: ErrorHandler;
}

export async function get(url: string, config?: RequestConfig) {
  return request('get', url, config);
}

export async function post(url: string, config?: RequestConfig) {
  return request('post', url, config);
}

export async function put(url: string, config?: RequestConfig) {
  return request('put', url, config);
}

export async function delete_(url: string, config?: RequestConfig) {
  return request('delete', url, config);
}

export async function request(
  method: Method,
  url: string,
  config?: RequestConfig,
) {
  const retry = {
    maxTries: method.toLowerCase() === 'get' ? 3 : 1,
    retryOnStatus: [408, 429, 500, 502, 503, 504],
    backoffFactorMs: 100,
    maxBackoffMs: 10000,
    ...(config?.retry || {}),
  };
  retry.maxTries = Number.isInteger(retry.maxTries) ? Math.max(retry.maxTries, 1) : 1;

  const requestConfig: AxiosRequestConfig = {
    method,
    url,
    responseType: 'text',
    timeout: 5000,
    transformResponse: [transformResponseData].concat(config?.transformResponse ?? []),
    ...config,
  };

  let tries = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let retryDelayMs;
    try {
      const response = await axios.request(requestConfig);
      return config?.rawResponse ? response : response.data;
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        throw error;
      }
      const axiosError = <AxiosError>error;
      const response = axiosError.response;
      let timeout = false;

      if (response) {
        let expectedErrorStatus = true;
        let valueOrFn;
        if (config?.onErrorStatus !== undefined && response.status in config.onErrorStatus) {
          valueOrFn = config.onErrorStatus[response.status];
        } else if (
          typeof config?.onClientError === 'function' &&
          response.status >= 400 &&
          response.status < 500
        ) {
          valueOrFn = config.onClientError;
        } else if (typeof config?.onServerError === 'function' && response.status >= 500) {
          valueOrFn = config.onServerError;
        } else {
          expectedErrorStatus = false;
        }
        if (expectedErrorStatus) {
          return typeof valueOrFn === 'function' ? valueOrFn(axiosError) : valueOrFn;
        }
      } else {
        timeout =
          axiosError.code === 'ETIMEOUT' ||
          // https://github.com/axios/axios/issues/1543
          (axiosError.code === 'ECONNABORTED' && /timeout/.test(axiosError.message));
      }

      // re-throw if error is not retryable
      if (
        timeout || // don't retry timeouts
        tries === retry.maxTries ||
        (response && !retry.retryOnStatus.includes(response.status))
      ) {
        throw axiosError;
      }

      if (response) {
        retryDelayMs = parseRetryAfter(response);
        // if Retry-After header exceeds the max backoff, re-throw
        if (retryDelayMs && retryDelayMs > retry.maxBackoffMs) {
          throw axiosError;
        }
      }
    }
    tries += 1;
    if (retryDelayMs === null || retryDelayMs === undefined) {
      // Delay with backoff
      retryDelayMs = Math.min(retry.maxBackoffMs, retry.backoffFactorMs * Math.pow(2, tries - 1));
    }
    await new Promise((resolve) => {
      setTimeout(resolve, retryDelayMs);
    });
  }
}

const transformResponseData: AxiosResponseTransformer = (data, headers?: AxiosResponseHeaders) => {
  // try to parse as JSON if the content-type indicates it's JSON, bytes, or missing
  if (typeof data === 'string' && isMaybeJSONResponse(headers)) {
    try {
      return JSON.parse(data);
    } catch (e) {
      // ignore
    }
  }
  return data;
};

const isMaybeJSONResponse = (headers?: AxiosResponseHeaders): boolean => {
  const contentType = headers?.['content-type'] || '';
  // match json, bytes, or empty/missing
  return /^application\/(hal\+)?json\b|^application\/octet-stream\b|^$/i.test(contentType);
};

const parseRetryAfter = (response?: AxiosResponse) => {
  // Return the number of milliseconds to wait before retrying, based on
  // the Retry-After header or 0 if header missing or invalid.
  // See https://tools.ietf.org/html/rfc7231#section-7.1.3
  const retryAfter = response?.headers?.['retry-after'];
  if (!retryAfter) {
    return null;
  }
  // check if it's a delay in seconds
  const delayS = Number(retryAfter);
  if (!Number.isNaN(delayS)) {
    return Math.max(0, delayS * 1000);
  }
  // check if it's a date to retry on
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - new Date().getTime());
  }
  return null;
};
