import {describe,it,expect} from 'bun:test'
import {parseRouteToNavigationState,buildRouteFromNavigationState,parseCompoundRoute,parseRoute} from '../route-parser'
import {isDetailNavState} from '../../renderer/lib/nav-helpers'
describe('knowledge graph and agent navigation',()=>{
 for(const navigator of ['knowledge','knowledge-chat'] as const)it(`roundtrips standalone ${navigator} and rejects ambiguous tails`,()=>{
  const state={navigator}
  expect(parseRouteToNavigationState(navigator)).toEqual(state)
  expect(buildRouteFromNavigationState(state)).toBe(navigator)
  expect(parseRoute(navigator)).toEqual({type:'view',name:navigator,params:{}})
  expect(isDetailNavState(state)).toBe(true)
  expect(parseCompoundRoute(navigator+'/unknown')).toBeNull()
 })
})
