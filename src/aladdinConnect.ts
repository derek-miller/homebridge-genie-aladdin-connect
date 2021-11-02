import {Logger} from 'homebridge';
import cacheManager, {Cache} from 'cache-manager';

import * as requests from './axioRequests';


interface AladdinUserInfo {
  email: string;
  fullName: string;
  id: string;
  rid: string;
  meta: AladdinUserInfoMeta | null;
  phoneNumber: string;
  userName: string;
  activated: boolean;
  // groups: AladdinGroup[]; // TODO
  permissions: AladdinUserPermission[];
}

interface AladdinUserInfoMeta {
  acceptTerms: boolean;
  securityQuestion: number;
  securityAnswer: string;
}

interface AladdinUserPermission {
  access: string;
  oid: AladdinUserPermissionOid;
}

interface AladdinUserPermissionOid {
  type: AladdinUserPermissionType;
  id: string;
}

type AladdinUserPermissionType = 'Portal' | 'Domain' | 'Device';

interface AladdinPortal {
  PortalName: string;
  PortalID: string;
  PortalRID: string;
  UserEmail: string;
  Description: string;
  Permissions: AladdinPortalPermission[];
}

interface AladdinPortalPermission {
  access: string;
}

interface AladdinPortalDetails {
  devices: string[];
  id: string;
  info: AladdinPortalDetailsInfo;
}

interface AladdinPortalDetailsInfo {
  key: string;
  // TODO incomplete
}

export interface AladdinDoor {
  portal: string;
  device: string;
  id: number;
  name: string;
  // doorStatus: AladdinDoorStatus;
  // linkStatus: AladdinLinkStatus;
  // batteryPercent: number | null;
}

export interface AladdinDoorStatusInfo {
  door: AladdinDoor;
  status: AladdinDoorStatus;
  batteryPercent: number | null;
}

export enum AladdinDoorStatus {
  UNKNOWN = 0,
  OPEN = 1,
  OPENING = 2,
  TIMEOUT_OPENING = 3,
  CLOSED = 4,
  CLOSING = 5,
  TIMEOUT_CLOSING = 6,
  NOT_CONFIGURED = 7,
}

export enum AladdinDesiredDoorStatus {
  CLOSED = 0,
  OPENED = 1,
}

enum AladdinLink {
  UNKNOWN = 0,
  NOT_CONFIGURED = 1,
  PAIRED = 2,
  CONNECTED = 3,
}

/**
 * https://documenter.getpostman.com/view/5856894/RzZAjHxV#cfb1b456-2c2d-42a5-9b73-6053d87a3feb
 */
export class AladdinConnect {
  private static readonly DEFAULT_HEADERS = {
    'AppVersion': '3.0.0',
    'BundleName': 'com.geniecompany.AladdinConnect',
    'User-Agent': 'Aladdin Connect iOS v3.0.0',
    'BuildVersion': '131',
  };

  private static readonly ALL_DOOR_IDS = [
    1,
    2,
    3,
  ];

  private cache: Cache;

  constructor(
    public readonly log: Logger,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.cache = cacheManager.caching({
      ttl: 0, // No default ttl
      max: 0, // Infinite capacity
      store: 'memory',
    });
  }

  private async getLoginToken(): Promise<string> {
    return this.cache.wrap(
      'getLoginToken',
      async () => requests.get(
        'https://genie.exosite.com/api/portals/v1/users/_this/token',
        {
          headers: {
            ...AladdinConnect.DEFAULT_HEADERS,
            Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
          },
        },
      ),
      {ttl: 3600},
    );
  }

  private async getUserInfo(): Promise<AladdinUserInfo> {
    return this.cache.wrap(
      'getUserInfo',
      async () => requests.get(
        'https://genie.exosite.com/api/portals/v1/users/_this',
        {
          headers: {
            ...AladdinConnect.DEFAULT_HEADERS,
            Authorization: `Token: ${await this.getLoginToken()}`,
          },
        },
      ),
      {ttl: 3600},
    );
  }

  private async getUserPortals(): Promise<AladdinPortal[]> {
    return this.cache.wrap(
      'getUserPortals',
      async () => {
        const {id} = await this.getUserInfo();
        return requests.get(
          `https://genie.exosite.com/api/portals/v1/users/${id}/portals`,
          {
            headers: {
              ...AladdinConnect.DEFAULT_HEADERS,
              Authorization: `Token: ${await this.getLoginToken()}`,
            },
          },
        );
      },
      {ttl: 3600},
    );
  }

  private async getUserPortalDetails(id: string): Promise<AladdinPortalDetails> {
    return this.cache.wrap(
      `getUserPortalDetails:${id}`,
      async () => requests.get(
        `https://genie.exosite.com/api/portals/v1/portals/${id}`,
        {
          headers: {
            ...AladdinConnect.DEFAULT_HEADERS,
            Authorization: `Token: ${await this.getLoginToken()}`,
          },
        },
      ),
      {ttl: 3600},
    );
  }

  private async getPortalKey(id: string): Promise<string> {
    const {info: {key}} = await this.getUserPortalDetails(id);
    return key;
  }

  private async getUserPortalsDetails(): Promise<AladdinPortalDetails[]> {
    const portals = await this.getUserPortals();
    return Promise.all(portals.map(({PortalID: id}) => this.getUserPortalDetails(id)));
  }

  async getAllDoors(): Promise<AladdinDoor[]> {
    const doorStatuses = await this.getAllDoorStatuses();
    return doorStatuses.map(({door}) => door);
  }

  async getDoorStatus(door: AladdinDoor): Promise<AladdinDoorStatusInfo | null> {
    return this.getDeviceDoorStatus(door.portal, door.device, door.id);
  }

  async getAllDoorStatuses(): Promise<AladdinDoorStatusInfo[]> {
    const statusPromises: Promise<AladdinDoorStatusInfo | null>[] = [];
    for (const {id: portalId, devices} of await this.getUserPortalsDetails()) {
      for (const deviceId of devices) {
        for (const doorId of AladdinConnect.ALL_DOOR_IDS) {
          statusPromises.push(this.getDeviceDoorStatus(portalId, deviceId, doorId));
        }
      }
    }
    return <AladdinDoorStatusInfo[]>(await Promise.all(statusPromises)).filter(status => status !== null);
  }

  private async getDeviceDoorStatus(
    portalId: string, deviceId: string, doorId: number,
  ): Promise<AladdinDoorStatusInfo | null> {
    if (!AladdinConnect.ALL_DOOR_IDS.includes(doorId)) {
      throw new Error(`unknown door id ${doorId}; must be one of [${AladdinConnect.ALL_DOOR_IDS.join(', ')}]`);
    }
    const cacheKey = `getDeviceDoorsStatus:${portalId}:${deviceId}:${doorId}`;
    const cachedResult = <AladdinDoorStatusInfo | null>await this.cache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const calls: object[] = [];
    let callId = 1;
    for (const func of ['name', 'door_status', 'link_status', 'battery_level']) {
      calls.push({
        id: callId++,
        procedure: 'read',
        arguments: [
          {
            alias: `dps${doorId}.${func}`,
          },
          {},
        ],
      });
    }
    const [
      nameCallResponse,
      doorStatusCallResponse,
      linkStatusCallResponse,
      batteryLevelCallResponse,
    ] = await requests.post(
      'https://genie.m2.exosite.com/onep:v1/rpc/process',
      {
        headers: {
          ...AladdinConnect.DEFAULT_HEADERS,
          'Content-Type': 'application/json',
          Authorization: `Token: ${await this.getLoginToken()}`,
        },
        retry: {
          maxTries: 3,
        },
        data: {
          auth: {
            cik: await this.getPortalKey(portalId),
            client_id: deviceId,
          },
          calls,
        },
      },
    );
    const name = AladdinConnect.getCallResult(nameCallResponse);
    const doorStatus = AladdinConnect.getCallResult(doorStatusCallResponse, AladdinDoorStatus.UNKNOWN);
    const linkStatus = AladdinConnect.getCallResult(linkStatusCallResponse, AladdinLink.UNKNOWN);
    const batteryLevel = AladdinConnect.getCallResult(batteryLevelCallResponse, null);
    let result: AladdinDoorStatusInfo | null = null;
    if (name) {
      result = {
        door: {
          portal: portalId,
          device: deviceId,
          id: doorId,
          name,
        },
        status: doorStatus,
        batteryPercent: linkStatus === AladdinLink.CONNECTED ? batteryLevel ?? null : null,
      };
    }
    const ttl = [
      AladdinDoorStatus.CLOSING,
      AladdinDoorStatus.OPENING,
    ].includes(result?.status ?? -1) ? 3 : 10;

    await this.cache.set(cacheKey, result, {ttl});
    return result;
  }

  async setDoorStatus(
    door: AladdinDoor, desiredStatus: AladdinDesiredDoorStatus,
  ): Promise<boolean> {
    await this.cache.del(`getDeviceDoorsStatus:${door.portal}:${door.device}:${door.id}`);
    const data = await requests.post(
      'https://genie.m2.exosite.com/onep:v1/rpc/process',
      {
        headers: {
          ...AladdinConnect.DEFAULT_HEADERS,
          'Content-Type': 'application/json',
          Authorization: `Token: ${await this.getLoginToken()}`,
        },
        retry: {
          maxTries: 3,
        },
        data: {
          'auth': {
            'cik': await this.getPortalKey(door.portal),
            'client_id': door.device,
          },
          'calls': [
            {
              arguments: [
                {
                  alias: `dps${door.id}.desired_status`,
                },
                desiredStatus,
              ],
              id: 1,
              procedure: 'write',
            },
            {
              arguments: [
                {
                  alias: `dps${door.id}.desired_status_user`,
                },
                this.username,
              ],
              id: 2,
              procedure: 'write',
            },
          ],
        },
      },
    );
    return data.every(({status}) => status === 'ok');
  }

  private static getCallResult(callResponse, defaultValue?) {
    if (callResponse?.status !== 'ok') {
      return defaultValue;
    }
    return callResponse?.result?.[0]?.[1] ?? defaultValue;
  }
}