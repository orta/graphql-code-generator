import { getNamedType, GraphQLArgument } from 'graphql';
import { Argument } from '../types';
import { resolveType } from './resolve-type';
import { resolveTypeIndicators } from './resolve-type-indicators';

export function resolveArguments(args: GraphQLArgument[]): Argument[] {
  return args.map((arg: GraphQLArgument): Argument => {
    const type = resolveType(arg.type);
    const namedType = getNamedType(arg.type);
    const indicators = resolveTypeIndicators(namedType);

    return {
      name: arg.name,
      description: arg.description || '',
      type: type.name,
      isRequired: type.isRequired,
      isArray: type.isArray,
      isEnum: indicators.isEnum,
      isScalar: indicators.isScalar,
      isInterface: indicators.isInterface,
      isUnion: indicators.isUnion,
      isInputType: indicators.isInputType,
      isType: indicators.isType,
    };
  });
}