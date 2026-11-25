import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);

const roomSchema = {
	type: 'object',
	required: ['id', 'code', 'name', 'building', 'capacity', 'active', 'enabled', 'resourceIds'],
	properties: {
		id: { type: 'string', format: 'uuid' },
		code: { type: 'string', minLength: 1, maxLength: 20 },
		name: { type: 'string', minLength: 1, maxLength: 100 },
		building: { type: 'string', minLength: 1, maxLength: 50 },
		capacity: { type: ['integer', 'null'], minimum: 1 },
		active: { type: 'boolean' },
		enabled: { type: 'boolean' },
		resourceIds: {
			type: 'array',
			items: { type: 'string', format: 'uuid' },
		},
	},
	additionalProperties: false,
};

// additionalProperties é intencionalmente omitido (aberto) em classSchema para acomodar
// os demais atributos normativos retornados pelo serviço classes (courseId, seats, dates, etc.).
const classSchema = {
	type: 'object',
	required: ['id', 'roomId', 'year', 'semester', 'enabled'],
	properties: {
		id: { type: 'string', format: 'uuid' },
		roomId: { type: 'string', format: 'uuid' },
		year: { type: 'integer' },
		semester: { type: 'integer' },
		enabled: { type: 'boolean' },
	},
};

export const validRoom = ajv.compile(roomSchema);
export const validClass = ajv.compile(classSchema);
