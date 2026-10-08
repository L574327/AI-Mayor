import { describe, expect, test } from '@jest/globals';
import {
  isValidUsername,
  isValidEmail,
  isValidPassword,
  isValidMCPServer,
  isValidMCPServerKey,
} from '../../src/utils/validators';

describe('utils/validators', () => {
  test('isValidUsername', () => {
    expect(isValidUsername('你好')).toBe(true);
    expect(isValidUsername('你')).toBe(false);
    expect(isValidUsername('Jack')).toBe(true);
    expect(isValidUsername('<Jack>')).toBe(false);
    expect(isValidUsername('Jack-')).toBe(false);
    expect(isValidUsername('Jack-1')).toBe(false);
    expect(isValidUsername('Jack.Tom')).toBe(true);
    expect(isValidUsername('Jack.')).toBe(false);
    expect(isValidUsername('.Jack')).toBe(false);
    expect(isValidUsername('Jack.Tom.')).toBe(false);
    expect(isValidUsername('Ross*Jack')).toBe(false);
    expect(isValidUsername('Ross&Jack')).toBe(false);
    expect(isValidUsername('123456789098765432101')).toBe(false);
    expect(isValidUsername('1123')).toBe(true);
    expect(isValidUsername("Ross'd")).toBe(false);
    expect(isValidUsername('Ross"d')).toBe(false);
    expect(isValidUsername('Ross+Jack')).toBe(false);
    expect(isValidUsername('Ross‘Jack')).toBe(false);
    expect(isValidUsername('Ross“Jack')).toBe(false);
    expect(isValidUsername('Ross?')).toBe(false);
    expect(isValidUsername('Ross*T')).toBe(false);
    expect(isValidUsername('    ')).toBe(false);
  });

  test('isValidEmail', () => {
    expect(isValidEmail('you@company.com')).toBe(true);
    expect(isValidEmail('you+23@company.cn')).toBe(true);
    expect(isValidEmail('you@company.co')).toBe(true);
    expect(isValidEmail('name.lastname@company.com')).toBe(true);
    expect(isValidEmail('you@company.com.cn')).toBe(true);
    expect(isValidEmail('you@company')).toBe(false);
    expect(isValidEmail('you@@company.com')).toBe(false);
    expect(isValidEmail('@company')).toBe(false);
    expect(isValidEmail('company')).toBe(false);
    expect(isValidEmail('you@name@compan.com')).toBe(false);
  });

  test('isValidPassword', () => {
    expect(isValidPassword('WX1342')).toBe(true);
    expect(isValidPassword('WX134')).toBe(false);
    expect(isValidPassword('134423')).toBe(false);
    expect(isValidPassword('ewjfhsdakjh')).toBe(false);
    expect(isValidPassword('Gd2303')).toBe(true);
    expect(isValidPassword('Pass12345678909876541')).toBe(false);
  });

  test('isValidMCPServer', () => {
    const svr1 = {
      name: 'AMap',
      command: 'npx',
      description: 'MCP Server for AMap (GaoDe Map)',
      args: ['-y', '@amap/amap-maps-mcp-server'],
      env: {
        AMAP_MAPS_API_KEY:
          '{{amapKey@string::got it from https://lbs.amap.com/api/mcp-server/create-project-and-key }}',
      },
      homepage: 'https://lbs.amap.com/api/mcp-server/summary',
    };
    expect(isValidMCPServer(svr1)).toBe(true);

    const svr2 = {
      name: 'InvalidServer',
      command: 'invalid-command',
      args: 'not-an-array',
    };
    expect(isValidMCPServer(svr2)).toBe(false);

    const svr3 = {
      name: 'AMap',
      command: 'npx',
      description: 'MCP Server for AMap (GaoDe Map)',
      env: {
        AMAP_MAPS_API_KEY:
          '{{amapKey@string::got it from https://lbs.amap.com/api/mcp-server/create-project-and-key }}',
      },
      homepage: 'https://lbs.amap.com/api/mcp-server/summary',
    };
    expect(isValidMCPServer(svr3)).toBe(true);
  });

  test('isValidMCPServerKey', () => {
    expect(isValidMCPServerKey('AMap')).toBe(true);
    expect(isValidMCPServerKey('valid-key')).toBe(true);
    expect(isValidMCPServerKey('invalid-key-')).toBe(false);
    expect(isValidMCPServerKey('invalid-key-1')).toBe(true);
    expect(isValidMCPServerKey('invalid-key--1')).toBe(false);
    expect(isValidMCPServerKey('invalid-key-1-')).toBe(false);
    expect(isValidMCPServerKey('invalid-key-1-2')).toBe(true);
  });
});
